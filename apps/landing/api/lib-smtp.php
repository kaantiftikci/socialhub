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
        // önceki sürümün kaydettiği yerel sunucu yolu (127.0.0.1:25 kimliksiz; posta iletilmiyordu) → Türkticaret varsayılanına dön
        if (is_array($d) && (isset($d['auth']) || in_array(strtolower((string) ($d['host'] ?? '')), ['localhost', '127.0.0.1', '::1'], true))) {
            unset($d['auth']);
            $d = array_merge($d, ['host' => 'smtp.turkticaret.net', 'port' => 465, 'secure' => 'ssl']);
            @file_put_contents($p, json_encode($d, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
        }
        return is_array($d) && !empty($d['host']) && !empty($d['user']) ? $d : null;
    }

    /**
     * E-posta gönder (düz metin; $html verilirse metin + HTML "multipart/alternative"). SMTP yapılandırılmışsa SMTP,
     * değilse mail() (yedek, teslimi güvenilmez).
     * @return array{ok: bool, via: string, error?: string, log?: string[]}
     */
    function mv_send_mail(string $to, string $subject, string $body, ?string $replyTo = null, ?string $html = null, array $inline = []): array
    {
        $to = trim($to);
        if (!filter_var($to, FILTER_VALIDATE_EMAIL) || preg_match('/[\r\n]/', $to)) {
            return ['ok' => false, 'via' => 'none', 'error' => 'Geçersiz alıcı adresi'];
        }
        $cfg = mv_smtp_config();
        if ($cfg) {
            // Paylaşımlı barındırmada giden SMTP portlarından biri kapalı olabiliyor ("Connection refused"): bağlantı kurulamazsa
            // öteki standart porta (465 SSL ↔ 587 STARTTLS) geç. Kimlik reddi gibi sunucu yanıtlarında yeniden denenmez.
            $res = mv_smtp_send($cfg, $to, $subject, $body, $replyTo, $html, $inline);
            if ($res['ok'] || empty($res['connectFailed'])) {
                return $res;
            }
            $alts = [['port' => 587, 'secure' => 'tls'], ['port' => 465, 'secure' => 'ssl']];
            $log = array_merge(['— ' . ($res['error'] ?? '')], $res['log'] ?? []);
            foreach ($alts as $alt) {
                if ((int) ($cfg['port'] ?? 0) === $alt['port']) {
                    continue;
                }
                $try = mv_smtp_send(array_merge($cfg, $alt), $to, $subject, $body, $replyTo, $html, $inline);
                $log[] = '— ' . $alt['port'] . ' (' . $alt['secure'] . '): ' . ($try['ok'] ? 'başarılı' : ($try['error'] ?? ''));
                $log = array_merge($log, $try['log'] ?? []);
                if ($try['ok']) {
                    // çalışan portu kaydet (sonraki gönderimler doğrudan onu kullansın)
                    @file_put_contents(mv_smtp_path(), json_encode(array_merge($cfg, $alt), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
                    return ['ok' => true, 'via' => 'smtp', 'log' => $log, 'note' => $alt['port'] . ' portuna geçildi ve kaydedildi'];
                }
                if (empty($try['connectFailed'])) {
                    return ['ok' => false, 'via' => 'smtp', 'error' => $try['error'] ?? '', 'log' => $log];
                }
            }
            $log = array_merge($log, mv_smtp_diag((string) $cfg['host']));
            // Barındırmanın yerel posta sunucusu (localhost) bilerek denenmez: Türkticaret paylaşımlı barındırmada postayı kimliksiz
            // kabul edip "gönderildi" diyor ama iletmiyor (mail() ile aynı); kurumsal posta kutusu da orada değil (535).
            return ['ok' => false, 'via' => 'smtp', 'error' => 'Barındırma sunucusu dışarıya e-posta bağlantısını (465 ve 587) engelliyor. Türkticaret desteğinden bu hosting hesabı için smtp.turkticaret.net\'e giden SMTP erişimini açmalarını iste.', 'log' => $log];
        }
        [$ctype, $payload] = mv_mime_body($body, $html, $inline);
        $headers = implode("\r\n", array_merge([
            'From: Mivelo <hello@mivelo.app>',
            'Reply-To: ' . ($replyTo && filter_var($replyTo, FILTER_VALIDATE_EMAIL) ? $replyTo : 'hello@mivelo.app'),
            'MIME-Version: 1.0',
        ], $ctype));
        $ok = @mail($to, mv_mime_header($subject), $payload, $headers, '-fhello@mivelo.app');
        return ['ok' => $ok, 'via' => 'mail()', 'error' => $ok ? 'SMTP ayarlı değil: sunucunun mail() işlevi kullanıldı; teslim edilmeyebilir (Ayarlar → E-posta gönderimi)' : 'mail() başarısız'];
    }

    /**
     * Bağlantı tanısı (destek ekibine gösterilecek): ad hangi IP'lere çözülüyor, her IP'de 587/465/25/2525 açık mı.
     * @return string[]
     */
    function mv_smtp_diag(string $host): array
    {
        $out = ['— Tanı (barındırma sunucusundan ' . $host . '):'];
        $ips = @gethostbynamel($host) ?: [];
        foreach ((@dns_get_record($host, DNS_AAAA) ?: []) as $r) {
            if (!empty($r['ipv6'])) {
                $ips[] = $r['ipv6'];
            }
        }
        if (!$ips) {
            return array_merge($out, ['  ad çözülemedi (DNS)']);
        }
        $out[] = '  IP: ' . implode(', ', $ips) . ' · sunucu: ' . (gethostname() ?: '?');
        foreach (array_slice($ips, 0, 3) as $ip) {
            $res = [];
            foreach ([587, 465, 25, 2525] as $port) {
                $t = microtime(true);
                $fp = @stream_socket_client('tcp://' . (str_contains($ip, ':') ? "[$ip]" : $ip) . ':' . $port, $en, $es, 5);
                $res[] = $port . ' ' . ($fp ? 'açık' : 'kapalı (' . ($es ?: 'zaman aşımı') . ', ' . round((microtime(true) - $t) * 1000) . ' ms)');
                if ($fp) {
                    fclose($fp);
                }
            }
            $out[] = '  ' . $ip . ': ' . implode(' · ', $res);
        }
        return $out;
    }

    function mv_mime_header(string $s): string
    {
        return preg_match('/[^\x20-\x7e]/', $s) ? '=?UTF-8?B?' . base64_encode($s) . '?=' : $s;
    }

    /**
     * Gövde: yalnız metin ya da metin + HTML (multipart/alternative; HTML'i göstermeyen istemci metni okur).
     * $inline (cid => [içerik türü, ikili veri]) verilirse HTML'e gömülü görseller: multipart/related (logo, uzaktan görsel
     * engellenen istemcilerde de görünür; HTML'de src="cid:<ad>").
     * @return array{0: string[], 1: string} [içerik başlıkları, gövde (CRLF)]
     */
    function mv_mime_body(string $text, ?string $html, array $inline = []): array
    {
        $b64 = fn (string $v) => rtrim(chunk_split(base64_encode($v), 76, "\r\n"));
        if ($html === null || $html === '') {
            return [['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'], $b64($text)];
        }
        $bd = 'mv-' . bin2hex(random_bytes(10));
        $parts = [];
        foreach ([['text/plain', $text], ['text/html', $html]] as [$t, $v]) {
            $parts[] = "--$bd\r\nContent-Type: $t; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . $b64($v);
        }
        $alt = implode("\r\n", $parts) . "\r\n--$bd--";
        if (!$inline) {
            return [['Content-Type: multipart/alternative; boundary="' . $bd . '"'], $alt];
        }
        $rb = 'mvr-' . bin2hex(random_bytes(10));
        $out = "--$rb\r\nContent-Type: multipart/alternative; boundary=\"$bd\"\r\n\r\n" . $alt;
        foreach ($inline as $cid => [$type, $data]) {
            $cid = preg_replace('/[^a-z0-9.@-]/i', '', (string) $cid);
            $name = $cid . '.' . (explode('/', (string) $type)[1] ?? 'bin');
            $out .= "\r\n--$rb\r\nContent-Type: $type; name=\"$name\"\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <$cid>\r\n"
                . "Content-Disposition: inline; filename=\"$name\"\r\n\r\n" . $b64((string) $data);
        }
        return [['Content-Type: multipart/related; type="multipart/alternative"; boundary="' . $rb . '"'], $out . "\r\n--$rb--"];
    }

    /**
     * @param array<string, mixed> $cfg
     * @return array{ok: bool, via: string, error?: string, log?: string[]}
     */
    function mv_smtp_send(array $cfg, string $to, string $subject, string $body, ?string $replyTo = null, ?string $html = null, array $inline = []): array
    {
        $host = (string) $cfg['host'];
        $port = (int) ($cfg['port'] ?? 465);
        $secure = (string) ($cfg['secure'] ?? ($port === 465 ? 'ssl' : 'tls'));
        $user = (string) $cfg['user'];
        $pass = (string) ($cfg['pass'] ?? '');
        $from = (string) ($cfg['from'] ?? $user);
        $fromName = (string) ($cfg['fromName'] ?? 'Mivelo');
        $log = [];
        $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'SNI_enabled' => true, 'peer_name' => $host]]);
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
            $cmd('AUTH LOGIN', [334]);
            $cmd(base64_encode($user), [334], '(kullanıcı adı)');
            $cmd(base64_encode($pass), [235], '(şifre)');
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
            ];
            [$ctype, $payload] = mv_mime_body($body, $html, $inline);
            $headers = array_merge($headers, $ctype);
            if ($replyTo && filter_var($replyTo, FILTER_VALIDATE_EMAIL) && !preg_match('/[\r\n]/', $replyTo)) {
                $headers[] = 'Reply-To: <' . $replyTo . '>';
            }
            $data = implode("\r\n", $headers) . "\r\n\r\n" . $payload . "\r\n.";
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
