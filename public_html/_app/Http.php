<?php
/** Request reading and JSON responses. */
final class Http
{
    private static ?array $jsonBody = null;

    public static function method(): string
    {
        return strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    }

    /** Decoded JSON body, cached. */
    public static function body(): array
    {
        if (self::$jsonBody !== null) {
            return self::$jsonBody;
        }
        $raw = file_get_contents('php://input') ?: '';
        $decoded = json_decode($raw, true);
        self::$jsonBody = is_array($decoded) ? $decoded : [];
        return self::$jsonBody;
    }

    /** Value from JSON body, then POST, then GET. */
    public static function input(string $key, $default = null)
    {
        $body = self::body();
        if (array_key_exists($key, $body)) {
            return $body[$key];
        }
        if (array_key_exists($key, $_POST)) {
            return $_POST[$key];
        }
        if (array_key_exists($key, $_GET)) {
            return $_GET[$key];
        }
        return $default;
    }

    public static function str(string $key, string $default = ''): string
    {
        $v = self::input($key, $default);
        return is_scalar($v) ? trim((string)$v) : $default;
    }

    public static function int(string $key, int $default = 0): int
    {
        $v = self::input($key, $default);
        return is_numeric($v) ? (int)$v : $default;
    }

    public static function float(string $key, float $default = 0.0): float
    {
        $v = self::input($key, $default);
        return is_numeric($v) ? (float)$v : $default;
    }

    public static function bool(string $key, bool $default = false): bool
    {
        $v = self::input($key, $default);
        if (is_bool($v)) {
            return $v;
        }
        if (is_string($v)) {
            return in_array(strtolower($v), ['1', 'true', 'yes', 'on'], true);
        }
        return (bool)$v;
    }

    public static function query(string $key, string $default = ''): string
    {
        return isset($_GET[$key]) && is_scalar($_GET[$key]) ? trim((string)$_GET[$key]) : $default;
    }

    public static function json($data, int $status = 200): void
    {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json; charset=utf-8');
            header('X-Content-Type-Options: nosniff');
            header('Cache-Control: no-store');
        }
        echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }

    public static function ok($data = []): void
    {
        self::json(['ok' => true] + (is_array($data) ? $data : ['data' => $data]));
    }

    public static function fail(string $message, int $status = 400, array $extra = []): void
    {
        self::json(['ok' => false, 'error' => $message] + $extra, $status);
    }

    public static function redirect(string $url, int $status = 302): void
    {
        header('Location: ' . $url, true, $status);
        exit;
    }
}
