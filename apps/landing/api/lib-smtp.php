<?php
declare(strict_types=1);

/**
 * Kimlik doğrulamalı SMTP gönderimi (bağımlılıksız). PHP mail() cPanel'de postayı yerel kuyruğa bırakıp "gönderildi" diyordu ama
 * mivelo.app adına kimliksiz gönderilen postalar SPF/DKIM yüzünden alıcıda reddediliyor ya da spama düşüyordu. Burada gerçek bir
 * posta kutusuyla (ör. hello@mivelo.app, cPanel → E-posta Hesapları) oturum açılıp gönderilir.
 * Yapılandırma ~/mivelo-data/smtp.json (web kökü dışında, 0600): host, port, secure ('ssl' | 'tls' | 'none'), user, pass, from, fromName.
 * Bu dosya yalnız işlev tanımlar; doğrudan açılırsa hiçbir şey yapmaz.
 */

if (!function_exists('mv_smtp_config')) {
    function mv_smtp_path(): string
    {
        return dirname(__DIR__, 2) . '/mivelo-data/smtp.json';
    }

    /** @return array<string, mixed>|null */
    function mv_smtp_config(): ?array
    {
        $p = mv_smtp_path();
        if (!is_file($p)) {
            return null;
        }
        $d = json_decode((string) @file_get_contents($p), true);
        return is_array($d) && !empty($d['host']) && !empty($d['user']) ? $d : null;
    }

    /**
     * Düz metin e-posta gönder. SMTP yapılandırılmışsa SMTP, değilse mail() (yedek, teslimi güvenilmez).
     * @return array{ok: bool, via: string, error?: string, log?: string[]}
     */
    function mv_send_mail(string $to, string $subject, string $body, ?string $replyTo = null): array
    {
        $to = trim($to);
        if (!filter_var($to, FILTER_VALIDATE_EMAIL) || preg_match('/[\r\n]/', $to)) {
            return ['ok' => false, 'via' => 'none', 'error' => 'Geçersiz alıcı adresi'];
        }
        $cfg = mv_smtp_config();
        if ($cfg) {
            // Paylaşımlı barındırmada giden SMTP portlarından biri kapalı olabiliyor ("Connection refused"): bağlantı kurulamazsa
            // öteki standart porta (465 SSL ↔ 587 STARTTLS) geç. Kimlik reddi gibi sunucu yanıtlarında yeniden denenmez.
            $res = mv_smtp_send($cfg, $to, $subject, $body, $replyTo);
            if ($res['ok'] || empty($res['connectFailed'])) {
                return $res;
            }
            // son çare: barındırmanın yerel posta sunucusu (cPanel "SMTP Restrictions" açıkken betikler yalnız localhost'a bağlanabilir;
            // posta kutusu aynı sunucudaysa çalışır)
            $alts = [['port' => 587, 'secure' => 'tls'], ['port' => 465, 'secure' => 'ssl'], ['host' => 'localhost', 'port' => 587, 'secure' => 'tls'], ['host' => 'localhost', 'port' => 25, 'secure' => 'none'],
                // yerel sunucu posta kutusunu tanımıyorsa (535: kutu başka sunucuda): cPanel Exim yerelden gelen postayı kimliksiz iletir
                ['host' => '127.0.0.1', 'port' => 25, 'secure' => 'none', 'auth' => false], ['host' => 'localhost', 'port' => 25, 'secure' => 'none', 'auth' => false]];
            $log = array_merge(['— ' . ($res['error'] ?? '')], $res['log'] ?? []);
            foreach ($alts as $alt) {
                if (!isset($alt['host']) && (int) ($cfg['port'] ?? 0) === $alt['port']) {
                    continue;
                }
                $try = mv_smtp_send(array_merge($cfg, $alt), $to, $subject, $body, $replyTo);
                $log[] = '— ' . ($alt['host'] ?? $cfg['host']) . ':' . $alt['port'] . ' (' . $alt['secure'] . (($alt['auth'] ?? true) ? '' : ', kimliksiz') . '): ' . ($try['ok'] ? 'başarılı' : ($try['error'] ?? ''));
                $log = array_merge($log, $try['log'] ?? []);
                if ($try['ok']) {
                    // çalışan portu kaydet (sonraki gönderimler doğrudan onu kullansın)
                    $saved = array_merge($cfg, $alt);
                    @file_put_contents(mv_smtp_path(), json_encode($saved, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
                    return ['ok' => true, 'via' => 'smtp', 'log' => $log, 'note' => ($alt['host'] ?? $cfg['host']) . ':' . $alt['port'] . ' kullanıldı ve kaydedildi'];
                }
                // yerel yollarda kimlik reddi de sonraki yolu engellemez
                if (empty($try['connectFailed']) && !isset($alt['host'])) {
                    return ['ok' => false, 'via' => 'smtp', 'error' => $try['error'] ?? '', 'log' => $log];
                }
                if (empty($try['connectFailed'])) {
                    $localErr = $try['error'] ?? '';
                }
            }
            if (!empty($localErr)) {
                return ['ok' => false, 'via' => 'smtp', 'error' => 'Dış SMTP portları (465/587) barındırmada kapalı; sunucunun kendi posta sunucusu da postayı kabul etmedi (' . $localErr . '). Barındırma desteğinden giden SMTP erişimi iste ya da gönderen adresi için bu barındırmada (cPanel → E-posta Hesapları) bir posta kutusu açıp bilgilerini buraya yaz.', 'log' => $log];
            }
            return ['ok' => false, 'via' => 'smtp', 'error' => 'SMTP sunucusuna hiçbir yoldan bağlanılamadı (465, 587 ve sunucunun yerel posta sunucusu): barındırma, betiklerin dışarıya e-posta bağlantısını engelliyor (cPanel "SMTP Restrictions"). Barındırma sağlayıcısından giden SMTP (465/587) erişimini açmasını iste.', 'log' => $log];
        }
        $headers = implode("\r\n", [
            'From: Mivelo <hello@mivelo.app>',
            'Reply-To: ' . ($replyTo && filter_var($replyTo, FILTER_VALIDATE_EMAIL) ? $replyTo : 'hello@mivelo.app'),
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: base64',
        ]);
        $ok = @mail($to, mv_mime_header($subject), chunk_split(base64_encode($body)), $headers, '-fhello@mivelo.app');
        return ['ok' => $ok, 'via' => 'mail()', 'error' => $ok ? 'SMTP ayarlı değil: sunucunun mail() işlevi kullanıldı; teslim edilmeyebilir (Ayarlar → E-posta gönderimi)' : 'mail() başarısız'];
    }

    function mv_mime_header(string $s): string
    {
        return preg_match('/[^\x20-\x7e]/', $s) ? '=?UTF-8?B?' . base64_encode($s) . '?=' : $s;
    }

    /**
     * @param array<string, mixed> $cfg
     * @return array{ok: bool, via: string, error?: string, log?: string[]}
     */
    function mv_smtp_send(array $cfg, string $to, string $subject, string $body, ?string $replyTo = null): array
    {
        $host = (string) $cfg['host'];
        $port = (int) ($cfg['port'] ?? 465);
        $secure = (string) ($cfg['secure'] ?? ($port === 465 ? 'ssl' : 'tls'));
        $user = (string) $cfg['user'];
        $pass = (string) ($cfg['pass'] ?? '');
        $from = (string) ($cfg['from'] ?? $user);
        $fromName = (string) ($cfg['fromName'] ?? 'Mivelo');
        $log = [];
        $local = in_array(strtolower($host), ['localhost', '127.0.0.1', '::1'], true);
        // yerel posta sunucusunun sertifikası "localhost" adına olmaz; trafik makineden çıkmadığı için yalnız orada ad/zincir denetimi yok
        $ctx = stream_context_create(['ssl' => $local ? ['verify_peer' => false, 'verify_peer_name' => false, 'allow_self_signed' => true] : ['verify_peer' => true, 'verify_peer_name' => true, 'SNI_enabled' => true, 'peer_name' => $host]]);
        $remote = ($secure === 'ssl' ? 'ssl://' : 'tcp://') . $host . ':' . $port;
        $fp = @stream_socket_client($remote, $errno, $errstr, 15, STREAM_CLIENT_CONNECT, $ctx);
        if (!$fp) {
            return ['ok' => false, 'via' => 'smtp', 'connectFailed' => true, 'error' => "Sunucuya bağlanılamadı ($remote): $errstr", 'log' => $log];
        }
        stream_set_timeout($fp, 20);
        $read = function () use ($fp, &$log): array {
            $lines = '';
            while (($line = fgets($fp, 1024)) !== false) {
                $lines .= $line;
                if (strlen($line) < 4 || $line[3] === ' ') {
                    break;
                }
            }
            $log[] = 'S: ' . trim(substr($lines, 0, 300));
            return [(int) substr($lines, 0, 3), $lines];
        };
        $cmd = function (string $c, array $okCodes, string $shown = '') use ($fp, $read, &$log): array {
            fwrite($fp, $c . "\r\n");
            $log[] = 'C: ' . ($shown !== '' ? $shown : $c);
            $r = $read();
            if (!in_array($r[0], $okCodes, true)) {
                throw new RuntimeException(trim($r[1]) ?: 'Yanıt yok');
            }
            return $r;
        };
        try {
            $r = $read();
            if ($r[0] !== 220) {
                throw new RuntimeException('Karşılama yok: ' . trim($r[1]));
            }
            $ehlo = 'EHLO ' . (preg_replace('/[^a-z0-9.-]/i', '', (string) ($_SERVER['SERVER_NAME'] ?? 'mivelo.app')) ?: 'mivelo.app');
            $cmd($ehlo, [250]);
            if ($secure === 'tls') {
                $cmd('STARTTLS', [220]);
                if (!@stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | (defined('STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT') ? STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT : 0))) {
                    throw new RuntimeException('TLS kurulamadı');
                }
                $cmd($ehlo, [250]);
            }
            if (($cfg['auth'] ?? true) !== false) {
                $cmd('AUTH LOGIN', [334]);
                $cmd(base64_encode($user), [334], '(kullanıcı adı)');
                $cmd(base64_encode($pass), [235], '(şifre)');
            }
            $cmd('MAIL FROM:<' . $from . '>', [250]);
            $cmd('RCPT TO:<' . $to . '>', [250, 251]);
            $cmd('DATA', [354]);
            $domain = substr(strrchr($from, '@') ?: '@mivelo.app', 1);
            $headers = [
                'Date: ' . date('r'),
                'From: ' . mv_mime_header($fromName) . ' <' . $from . '>',
                'To: <' . $to . '>',
                'Subject: ' . mv_mime_header($subject),
                'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . $domain . '>',
                'MIME-Version: 1.0',
                'Content-Type: text/plain; charset=UTF-8',
                'Content-Transfer-Encoding: base64',
            ];
            if ($replyTo && filter_var($replyTo, FILTER_VALIDATE_EMAIL) && !preg_match('/[\r\n]/', $replyTo)) {
                $headers[] = 'Reply-To: <' . $replyTo . '>';
            }
            $data = implode("\r\n", $headers) . "\r\n\r\n" . rtrim(chunk_split(base64_encode($body), 76, "\r\n")) . "\r\n.";
            $cmd($data, [250], '(ileti)');
            fwrite($fp, "QUIT\r\n");
            fclose($fp);
            return ['ok' => true, 'via' => 'smtp', 'log' => $log];
        } catch (Throwable $e) {
            @fwrite($fp, "QUIT\r\n");
            @fclose($fp);
            return ['ok' => false, 'via' => 'smtp', 'error' => 'SMTP: ' . $e->getMessage(), 'log' => $log];
        }
    }
}
