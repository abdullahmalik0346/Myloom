<?php
/** Filesystem layout for recordings, thumbnails and logs. */
final class Storage
{
    public static function root(): string
    {
        return rtrim((string)Config::get('storage_dir'), '/');
    }

    public static function ensure(): void
    {
        foreach (['', '/videos', '/thumbs', '/tmp', '/logs', '/avatars', '/logos'] as $sub) {
            $dir = self::root() . $sub;
            if (!is_dir($dir)) {
                @mkdir($dir, 0755, true);
            }
        }
        self::protect(self::root());
    }

    /** Drop a deny-all .htaccess so files are only reachable through PHP. */
    public static function protect(string $dir): void
    {
        $file = $dir . '/.htaccess';
        if (is_file($file)) {
            return;
        }
        $rules = "# Direct access is denied; files are served by file.php after an access check.\n"
            . "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n"
            . "<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n";
        @file_put_contents($file, $rules);
    }

    /** Relative storage path for a video's media file. */
    public static function videoPath(string $uid, string $ext = 'webm'): string
    {
        $shard = substr(strtolower(preg_replace('/[^a-z0-9]/i', '', $uid) ?: 'x'), 0, 2);
        $dir = '/videos/' . $shard;
        if (!is_dir(self::root() . $dir)) {
            @mkdir(self::root() . $dir, 0755, true);
        }
        return $dir . '/' . $uid . '.' . $ext;
    }

    public static function abs(string $relative): string
    {
        return self::root() . '/' . ltrim($relative, '/');
    }

    public static function delete(?string $relative): void
    {
        if (!$relative) {
            return;
        }
        $path = self::abs($relative);
        if (is_file($path) && str_starts_with(realpath($path) ?: '', realpath(self::root()) ?: '###')) {
            @unlink($path);
        }
    }

    public static function size(?string $relative): int
    {
        if (!$relative) {
            return 0;
        }
        $path = self::abs($relative);
        return is_file($path) ? (int)filesize($path) : 0;
    }

    /** Free disk space, or null when the host disables disk_free_space(). */
    public static function freeSpace(): ?int
    {
        $free = @disk_free_space(self::root());
        return is_float($free) ? (int)$free : null;
    }

    /** Save a base64 data URL (thumbnails, avatars, logos) and return its relative path. */
    public static function saveDataUrl(string $dataUrl, string $subdir, string $name): ?string
    {
        if (!preg_match('#^data:image/(png|jpeg|jpg|webp|gif);base64,#i', $dataUrl, $m)) {
            return null;
        }
        $ext = strtolower($m[1]) === 'jpeg' ? 'jpg' : strtolower($m[1]);
        $binary = base64_decode(substr($dataUrl, strpos($dataUrl, ',') + 1), true);
        if ($binary === false || strlen($binary) > 8 * 1024 * 1024) {
            return null;
        }
        $dir = '/' . trim($subdir, '/');
        if (!is_dir(self::root() . $dir)) {
            @mkdir(self::root() . $dir, 0755, true);
        }
        $rel = $dir . '/' . $name . '.' . $ext;
        return file_put_contents(self::abs($rel), $binary, LOCK_EX) === false ? null : $rel;
    }
}
