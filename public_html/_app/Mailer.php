<?php
/**
 * Dependency-free mailer: talks SMTP over a socket when SMTP is configured,
 * otherwise falls back to PHP's mail() (which cPanel hosts provide by default).
 */
final class Mailer
{
    public static function send(string $toEmail, string $toName, string $subject, string $html): bool
    {
        $fromEmail = (string)Config::get('mail_from');
        if ($fromEmail === '') {
            $host = parse_url((string)Config::get('app_url'), PHP_URL_HOST) ?: 'localhost';
            $fromEmail = 'no-reply@' . preg_replace('/^www\./', '', $host);
        }
        $fromName = (string)Config::get('mail_from_name', 'MyLoom');
        $body = self::wrap($subject, $html);

        try {
            if ((string)Config::get('smtp_host') !== '') {
                return self::smtp($fromEmail, $fromName, $toEmail, $toName, $subject, $body);
            }
            $headers = [
                'MIME-Version: 1.0',
                'Content-Type: text/html; charset=UTF-8',
                'From: ' . self::header($fromName) . ' <' . $fromEmail . '>',
                'Reply-To: ' . $fromEmail,
                'X-Mailer: MyLoom',
            ];
            return @mail($toEmail, self::header($subject), $body, implode("\r\n", $headers));
        } catch (Throwable $e) {
            error_log('[myloom][mail] ' . $e->getMessage());
            return false;
        }
    }

    private static function header(string $value): string
    {
        return '=?UTF-8?B?' . base64_encode($value) . '?=';
    }

    private static function smtp(
        string $fromEmail,
        string $fromName,
        string $toEmail,
        string $toName,
        string $subject,
        string $body
    ): bool {
        $host = (string)Config::get('smtp_host');
        $port = (int)Config::get('smtp_port', 587);
        $secure = strtolower((string)Config::get('smtp_secure', 'tls'));
        $remote = ($secure === 'ssl' ? 'ssl://' : '') . $host . ':' . $port;

        $socket = @stream_socket_client($remote, $errno, $errstr, 15);
        if (!$socket) {
            throw new RuntimeException("SMTP connect failed: {$errstr} ({$errno})");
        }
        stream_set_timeout($socket, 15);

        $read = static function () use ($socket): string {
            $data = '';
            while (($line = fgets($socket, 1024)) !== false) {
                $data .= $line;
                if (strlen($line) < 4 || $line[3] === ' ') {
                    break;
                }
            }
            return $data;
        };
        $cmd = static function (string $line, string $expect) use ($socket, $read): void {
            fwrite($socket, $line . "\r\n");
            $response = $read();
            if (!str_starts_with(trim($response), $expect)) {
                throw new RuntimeException('SMTP error after "' . strtok($line, ' ') . '": ' . trim($response));
            }
        };

        $read();
        $ehlo = 'EHLO ' . (parse_url((string)Config::get('app_url'), PHP_URL_HOST) ?: 'localhost');
        $cmd($ehlo, '250');

        if ($secure === 'tls') {
            $cmd('STARTTLS', '220');
            if (!stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                throw new RuntimeException('SMTP STARTTLS negotiation failed.');
            }
            $cmd($ehlo, '250');
        }

        if ((string)Config::get('smtp_user') !== '') {
            $cmd('AUTH LOGIN', '334');
            $cmd(base64_encode((string)Config::get('smtp_user')), '334');
            $cmd(base64_encode((string)Config::get('smtp_pass')), '235');
        }

        $cmd('MAIL FROM:<' . $fromEmail . '>', '250');
        $cmd('RCPT TO:<' . $toEmail . '>', '250');
        $cmd('DATA', '354');

        $headers = implode("\r\n", [
            'Date: ' . date('r'),
            'From: ' . self::header($fromName) . ' <' . $fromEmail . '>',
            'To: ' . self::header($toName ?: $toEmail) . ' <' . $toEmail . '>',
            'Subject: ' . self::header($subject),
            'MIME-Version: 1.0',
            'Content-Type: text/html; charset=UTF-8',
            'Content-Transfer-Encoding: base64',
        ]);
        // Dot-stuffing is unnecessary for base64 payloads.
        $payload = $headers . "\r\n\r\n" . chunk_split(base64_encode($body), 76, "\r\n");
        fwrite($socket, $payload . "\r\n.\r\n");
        $response = $read();
        if (!str_starts_with(trim($response), '250')) {
            throw new RuntimeException('SMTP rejected the message: ' . trim($response));
        }
        fwrite($socket, "QUIT\r\n");
        fclose($socket);
        return true;
    }

    /** Shared HTML shell for every transactional email. */
    private static function wrap(string $title, string $html): string
    {
        $app = Util::e((string)Config::setting('site_name', 'MyLoom'));
        $url = Util::e((string)Config::get('app_url'));
        $safeTitle = Util::e($title);
        return <<<HTML
<!doctype html>
<html><head><meta charset="utf-8"><title>{$safeTitle}</title></head>
<body style="margin:0;padding:24px;background:#f4f4f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1b1b23">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e6e6ee">
      <tr><td style="padding:22px 28px;border-bottom:1px solid #eeeef4;font-weight:700;font-size:17px">{$app}</td></tr>
      <tr><td style="padding:28px;font-size:15px;line-height:1.6">{$html}</td></tr>
      <tr><td style="padding:18px 28px;background:#fafafd;color:#8a8a99;font-size:12px">
        Sent by <a href="{$url}" style="color:#625df5;text-decoration:none">{$app}</a>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>
HTML;
    }

    public static function button(string $label, string $url): string
    {
        $l = Util::e($label);
        $u = Util::e($url);
        return '<p style="margin:26px 0"><a href="' . $u . '" style="background:#625df5;color:#fff;'
            . 'padding:12px 22px;border-radius:9px;text-decoration:none;font-weight:600;display:inline-block">'
            . $l . '</a></p>';
    }
}
