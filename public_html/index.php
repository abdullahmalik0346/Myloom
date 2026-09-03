<?php
/**
 * MyLoom front controller for pages.
 *  /                      app shell (library, recorder, settings…)
 *  /v/{uid}               public watch page
 *  /s/{token}             watch page for a specific share link
 *  /embed/{uid|token}     minimal embeddable player
 * Everything else falls through to the SPA shell, which routes client-side.
 */
require_once __DIR__ . '/_app/bootstrap.php';

if (!myloom_installed()) {
    header('Location: ' . Util::basePath() . '/install.php');
    exit;
}

Auth::start();
Storage::ensure();

$path = trim(Util::requestPath(), '/');
$segments = $path === '' ? [] : explode('/', $path);
$page = $segments[0] ?? '';

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: strict-origin-when-cross-origin');

/** Load a watch target for the SSR pages. Returns [video, share] or nulls. */
function myloom_watch_target(string $kind, string $key): array
{
    if ($kind === 'share') {
        $share = Db::one('SELECT * FROM share_links WHERE token = ?', [$key]);
        if (!$share) {
            return [null, null];
        }
        $video = Db::one(
            'SELECT v.*, u.name AS owner_name, u.avatar AS owner_avatar,
                    w.name AS ws_name, w.logo AS ws_logo, w.accent_color AS ws_accent, w.hide_branding
             FROM videos v JOIN users u ON u.id = v.owner_id JOIN workspaces w ON w.id = v.workspace_id
             WHERE v.id = ?',
            [(int)$share['video_id']]
        );
        return [$video ?: null, $share];
    }
    $video = Db::one(
        'SELECT v.*, u.name AS owner_name, u.avatar AS owner_avatar,
                w.name AS ws_name, w.logo AS ws_logo, w.accent_color AS ws_accent, w.hide_branding
         FROM videos v JOIN users u ON u.id = v.owner_id JOIN workspaces w ON w.id = v.workspace_id
         WHERE v.uid = ?',
        [$key]
    );
    return [$video ?: null, null];
}

try {
    if (($page === 'v' || $page === 's') && !empty($segments[1])) {
        [$video, $share] = myloom_watch_target($page === 's' ? 'share' : 'uid', $segments[1]);
        if (!$video || !empty($video['deleted_at'])) {
            http_response_code(404);
            require APP_DIR . '/views/notfound.php';
            exit;
        }
        $shareToken = $share['token'] ?? null;
        require APP_DIR . '/views/watch.php';
        exit;
    }

    if ($page === 'embed' && !empty($segments[1])) {
        $key = $segments[1];
        [$video, $share] = myloom_watch_target('uid', $key);
        if (!$video) {
            [$video, $share] = myloom_watch_target('share', $key);
        }
        if (!$video || !empty($video['deleted_at'])) {
            http_response_code(404);
            exit('Video not found.');
        }
        $shareToken = $share['token'] ?? null;
        header_remove('X-Frame-Options');
        require APP_DIR . '/views/embed.php';
        exit;
    }

    // Everything else is the signed-in application shell.
    require APP_DIR . '/views/app.php';
} catch (Throwable $e) {
    error_log('[myloom][page] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    http_response_code(500);
    if (Config::get('debug')) {
        echo '<pre>' . Util::e($e->getMessage() . "\n" . $e->getTraceAsString()) . '</pre>';
    } else {
        echo 'Something went wrong. Check _storage/logs/php-error.log for details.';
    }
}
