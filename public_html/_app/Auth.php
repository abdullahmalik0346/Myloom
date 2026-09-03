<?php
/**
 * Cookie-session authentication.
 * Sessions are used (rather than bearer tokens) so that <video src> requests
 * and download links carry credentials without custom headers.
 */
final class Auth
{
    private static ?array $user = null;
    private static bool $started = false;
    private static ?int $tokenWorkspace = null;

    public static function start(): void
    {
        if (self::$started || session_status() === PHP_SESSION_ACTIVE) {
            self::$started = true;
            return;
        }
        $https = str_starts_with((string)Config::get('app_url'), 'https://');
        session_name('myloom_sid');
        session_set_cookie_params([
            'lifetime' => 0,
            'path'     => Util::basePath() . '/',
            'httponly' => true,
            'secure'   => $https,
            'samesite' => 'Lax',
        ]);
        session_start();
        self::$started = true;

        if (empty($_SESSION['csrf'])) {
            $_SESSION['csrf'] = Util::token(16);
        }
        if (empty($_SESSION['guest_key'])) {
            $_SESSION['guest_key'] = Util::token(16);
        }
    }

    /** Release the session lock so long streaming requests do not block the app. */
    public static function release(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
    }

    public static function csrf(): string
    {
        self::start();
        return $_SESSION['csrf'] ?? '';
    }

    public static function checkCsrf(): void
    {
        if (in_array(Http::method(), ['GET', 'HEAD', 'OPTIONS'], true)) {
            return;
        }
        // A bearer token is not sent automatically by the browser, so a
        // cross-site page cannot forge one. CSRF only applies to cookie auth.
        if (self::isTokenRequest()) {
            return;
        }
        $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? (string)Http::input('_csrf', '');
        if (!Util::hashEquals(self::csrf(), (string)$sent)) {
            Http::fail('Your session expired. Please refresh the page and try again.', 419);
        }
    }

    /** Anonymous but stable key used to de-duplicate views and reactions. */
    public static function guestKey(): string
    {
        self::start();
        return $_SESSION['guest_key'] ?? 'anon';
    }

    public static function login(int $userId): void
    {
        self::start();
        session_regenerate_id(true);
        $_SESSION['uid'] = $userId;
        $_SESSION['csrf'] = Util::token(16);
        Db::update('users', ['last_login_at' => Util::now()], 'id = ?', [$userId]);
        self::$user = null;
    }

    public static function logout(): void
    {
        self::start();
        $_SESSION = [];
        session_destroy();
        self::$user = null;
    }

    /** Bearer token from the Authorization header, if any. */
    private static function bearer(): string
    {
        $header = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
        if ($header === '' && function_exists('apache_request_headers')) {
            $headers = apache_request_headers() ?: [];
            foreach ($headers as $key => $value) {
                if (strcasecmp($key, 'Authorization') === 0) {
                    $header = (string)$value;
                    break;
                }
            }
        }
        return preg_match('/^Bearer\s+([A-Za-z0-9._-]+)$/i', trim($header), $m) ? $m[1] : '';
    }

    /** True when this request authenticated with a token rather than a cookie. */
    public static function isTokenRequest(): bool
    {
        return self::bearer() !== '';
    }

    /** Resolve an API token to its owner, or null. */
    private static function userFromToken(): ?array
    {
        $token = self::bearer();
        if ($token === '') {
            return null;
        }
        $hash = hash('sha256', $token);
        $row = Db::one(
            'SELECT t.id AS token_id, t.workspace_id, u.*
             FROM api_tokens t JOIN users u ON u.id = t.user_id
             WHERE t.token_hash = ? AND t.revoked = 0 AND u.is_active = 1',
            [$hash]
        );
        if (!$row) {
            return null;
        }
        // Touch at most once a minute; this runs on every chunk upload.
        if (empty($row['last_used_at']) || strtotime((string)$row['last_used_at']) < time() - 60) {
            Db::update('api_tokens', ['last_used_at' => Util::now()], 'id = ?', [(int)$row['token_id']]);
        }
        if (!empty($row['workspace_id'])) {
            self::$tokenWorkspace = (int)$row['workspace_id'];
        }
        unset($row['password_hash'], $row['verify_token'], $row['token_id'], $row['workspace_id']);
        return $row;
    }

    public static function user(): ?array
    {
        if (self::$user !== null) {
            return self::$user;
        }

        $tokenUser = self::userFromToken();
        if ($tokenUser) {
            self::$user = $tokenUser;
            return $tokenUser;
        }

        self::start();
        $id = (int)($_SESSION['uid'] ?? 0);
        if ($id <= 0) {
            return null;
        }
        $user = Db::one('SELECT * FROM users WHERE id = ? AND is_active = 1', [$id]);
        if (!$user) {
            return null;
        }
        unset($user['password_hash'], $user['verify_token']);
        self::$user = $user;
        return $user;
    }

    public static function id(): int
    {
        $u = self::user();
        return $u ? (int)$u['id'] : 0;
    }

    public static function check(): bool
    {
        return self::user() !== null;
    }

    public static function require(): array
    {
        $user = self::user();
        if (!$user) {
            Http::fail('You need to sign in to do that.', 401);
        }
        return $user;
    }

    public static function requireAdmin(): array
    {
        $user = self::require();
        if ((int)$user['is_admin'] !== 1) {
            Http::fail('Administrator access required.', 403);
        }
        return $user;
    }

    /** The workspace the user is currently acting in. */
    public static function workspaceId(): int
    {
        self::start();
        $user = self::user();
        if (!$user) {
            return 0;
        }
        if (self::$tokenWorkspace !== null &&
            Permissions::roleIn(self::$tokenWorkspace, (int)$user['id']) !== null) {
            return self::$tokenWorkspace;
        }
        if (self::isTokenRequest()) {
            $row = Db::one(
                'SELECT workspace_id FROM workspace_members WHERE user_id = ? ORDER BY id ASC LIMIT 1',
                [(int)$user['id']]
            );
            return $row ? (int)$row['workspace_id'] : 0;
        }

        $wsId = (int)($_SESSION['ws'] ?? 0);
        if ($wsId > 0 && Permissions::roleIn($wsId, (int)$user['id']) !== null) {
            return $wsId;
        }
        $row = Db::one(
            'SELECT workspace_id FROM workspace_members WHERE user_id = ? ORDER BY id ASC LIMIT 1',
            [(int)$user['id']]
        );
        $wsId = $row ? (int)$row['workspace_id'] : 0;
        $_SESSION['ws'] = $wsId;
        return $wsId;
    }

    public static function setWorkspace(int $wsId): void
    {
        self::start();
        $_SESSION['ws'] = $wsId;
    }

    /** Remember that a visitor unlocked a password-protected video. */
    public static function unlock(string $key): void
    {
        self::start();
        $_SESSION['unlocked'][$key] = true;
    }

    public static function isUnlocked(string $key): bool
    {
        self::start();
        return !empty($_SESSION['unlocked'][$key]);
    }

    /** Name/email a guest supplied on a lead-gated share page. */
    public static function guestIdentity(): array
    {
        self::start();
        return $_SESSION['guest_identity'] ?? [];
    }

    public static function setGuestIdentity(string $name, string $email): void
    {
        self::start();
        $_SESSION['guest_identity'] = ['name' => $name, 'email' => $email];
    }

    /** Basic per-session rate limiting for auth and comment endpoints. */
    public static function throttle(string $bucket, int $limit, int $seconds): void
    {
        self::start();
        $now = time();
        $hits = $_SESSION['throttle'][$bucket] ?? [];
        $hits = array_values(array_filter($hits, static fn($t) => $t > $now - $seconds));
        if (count($hits) >= $limit) {
            Http::fail('Too many attempts. Please wait a moment and try again.', 429);
        }
        $hits[] = $now;
        $_SESSION['throttle'][$bucket] = $hits;
    }
}
