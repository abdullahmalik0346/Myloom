<?php
/** Small helpers shared across the app. */
final class Util
{
    /** URL-safe random id used for video uids and share tokens. */
    public static function uid(int $bytes = 12): string
    {
        return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', 'ab'), '=');
    }

    public static function token(int $bytes = 32): string
    {
        return bin2hex(random_bytes($bytes));
    }

    public static function now(): string
    {
        return gmdate('Y-m-d H:i:s');
    }

    public static function slug(string $text, int $max = 60): string
    {
        $text = strtolower(trim($text));
        $text = preg_replace('/[^a-z0-9]+/', '-', $text) ?? '';
        $text = trim($text, '-');
        if ($text === '') {
            $text = 'ws-' . substr(bin2hex(random_bytes(4)), 0, 6);
        }
        return substr($text, 0, $max);
    }

    /** Base URL of the installation, derived from the current request. */
    public static function guessBaseUrl(): string
    {
        $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
            || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
            || (int)($_SERVER['SERVER_PORT'] ?? 80) === 443;
        $scheme = $https ? 'https' : 'http';
        $host = $_SERVER['HTTP_HOST'] ?? ($_SERVER['SERVER_NAME'] ?? 'localhost');
        return $scheme . '://' . $host . self::basePath();
    }

    /** Sub-directory the app is installed in, e.g. "" or "/myloom". */
    public static function basePath(): string
    {
        $script = $_SERVER['SCRIPT_NAME'] ?? '/index.php';
        $dir = str_replace('\\', '/', dirname($script));
        $dir = rtrim($dir, '/');
        return $dir === '.' ? '' : $dir;
    }

    /** Request path with the install sub-directory removed. */
    public static function requestPath(): string
    {
        $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
        $base = self::basePath();
        if ($base !== '' && str_starts_with($uri, $base)) {
            $uri = substr($uri, strlen($base));
        }
        return '/' . ltrim(rawurldecode($uri), '/');
    }

    public static function url(string $path = ''): string
    {
        return Config::get('app_url') . '/' . ltrim($path, '/');
    }

    public static function clientIp(): string
    {
        foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'] as $key) {
            if (!empty($_SERVER[$key])) {
                $ip = trim(explode(',', $_SERVER[$key])[0]);
                if (filter_var($ip, FILTER_VALIDATE_IP)) {
                    return $ip;
                }
            }
        }
        return '0.0.0.0';
    }

    public static function ipHash(): string
    {
        return substr(hash_hmac('sha256', self::clientIp(), (string)Config::get('app_secret')), 0, 32);
    }

    public static function device(): string
    {
        $ua = strtolower($_SERVER['HTTP_USER_AGENT'] ?? '');
        if (preg_match('/ipad|tablet/', $ua)) {
            return 'tablet';
        }
        if (preg_match('/mobile|iphone|android/', $ua)) {
            return 'mobile';
        }
        return 'desktop';
    }

    public static function e(?string $value): string
    {
        return htmlspecialchars((string)$value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    public static function isEmail(string $email): bool
    {
        return (bool)filter_var($email, FILTER_VALIDATE_EMAIL);
    }

    /** Human-readable byte size. */
    public static function bytes(int $bytes): string
    {
        $units = ['B', 'KB', 'MB', 'GB', 'TB'];
        $i = 0;
        $n = (float)$bytes;
        while ($n >= 1024 && $i < count($units) - 1) {
            $n /= 1024;
            $i++;
        }
        return round($n, $n < 10 && $i > 0 ? 1 : 0) . ' ' . $units[$i];
    }

    /** Constant-time comparison that tolerates nulls. */
    public static function hashEquals(?string $a, ?string $b): bool
    {
        return is_string($a) && is_string($b) && hash_equals($a, $b);
    }

    /** Signed, expiring token used for stream/download authorisation. */
    public static function sign(string $payload, int $ttl = 21600): string
    {
        $exp = time() + $ttl;
        $data = $payload . '|' . $exp;
        $sig = hash_hmac('sha256', $data, (string)Config::get('app_secret'));
        return rtrim(strtr(base64_encode($data . '|' . $sig), '+/', '-_'), '=');
    }

    public static function verifySigned(string $token, ?string &$payload = null): bool
    {
        $raw = base64_decode(strtr($token, '-_', '+/'), true);
        if ($raw === false) {
            return false;
        }
        $parts = explode('|', $raw);
        if (count($parts) !== 3) {
            return false;
        }
        [$payload, $exp, $sig] = $parts;
        $expect = hash_hmac('sha256', $payload . '|' . $exp, (string)Config::get('app_secret'));
        if (!hash_equals($expect, $sig)) {
            return false;
        }
        return (int)$exp > time();
    }

    /** Format seconds as m:ss / h:mm:ss. */
    public static function duration(float $seconds): string
    {
        $s = (int)round($seconds);
        $h = intdiv($s, 3600);
        $m = intdiv($s % 3600, 60);
        $sec = $s % 60;
        return $h > 0
            ? sprintf('%d:%02d:%02d', $h, $m, $sec)
            : sprintf('%d:%02d', $m, $sec);
    }
}
