<?php
/**
 * Media gateway.
 * Serves recordings, thumbnails, avatars, logos and caption tracks after an
 * access check, with HTTP Range support so viewers can seek.
 *
 *   file.php?v=<uid>[&token=<share>][&dl=1]  video stream / download
 *   file.php?t=<uid>                          poster image
 *   file.php?c=<uid>                          WebVTT captions
 *   file.php?a=<relative path>                avatar or workspace logo
 */
require_once __DIR__ . '/_app/bootstrap.php';

if (!myloom_installed()) {
    http_response_code(503);
    exit('Not installed.');
}

Auth::start();

/** Send a file with Range support and exit. */
function myloom_stream(string $absolute, string $mime, bool $download, string $downloadName, int $cacheSeconds): void
{
    if (!is_file($absolute)) {
        http_response_code(404);
        exit('Not found.');
    }
    $size = (int)filesize($absolute);
    $start = 0;
    $end = $size - 1;
    $status = 200;

    $range = $_SERVER['HTTP_RANGE'] ?? '';
    if ($range !== '' && preg_match('/bytes=(\d*)-(\d*)/i', $range, $m)) {
        if ($m[1] === '' && $m[2] !== '') {
            // Suffix range: the last N bytes.
            $start = max(0, $size - (int)$m[2]);
        } else {
            $start = (int)$m[1];
            if ($m[2] !== '') {
                $end = min((int)$m[2], $size - 1);
            }
        }
        if ($start > $end || $start >= $size) {
            header('Content-Range: bytes */' . $size);
            http_response_code(416);
            exit;
        }
        $status = 206;
    }

    $length = $end - $start + 1;

    // The session lock is no longer needed and would block other requests.
    Auth::release();
    while (ob_get_level() > 0) {
        ob_end_clean();
    }

    http_response_code($status);
    header('Content-Type: ' . $mime);
    header('Accept-Ranges: bytes');
    header('Content-Length: ' . $length);
    header('X-Content-Type-Options: nosniff');
    if ($status === 206) {
        header("Content-Range: bytes {$start}-{$end}/{$size}");
    }
    if ($cacheSeconds > 0) {
        header('Cache-Control: private, max-age=' . $cacheSeconds);
    } else {
        header('Cache-Control: private, no-store');
    }
    if ($download) {
        header('Content-Disposition: attachment; filename="'
            . preg_replace('/[^A-Za-z0-9._ -]/', '_', $downloadName) . '"');
    }
    if ($_SERVER['REQUEST_METHOD'] === 'HEAD') {
        exit;
    }

    $fh = fopen($absolute, 'rb');
    if (!$fh) {
        http_response_code(500);
        exit;
    }
    fseek($fh, $start);
    $chunk = 262144;
    $remaining = $length;
    while ($remaining > 0 && !feof($fh) && !connection_aborted()) {
        $read = fread($fh, (int)min($chunk, $remaining));
        if ($read === false) {
            break;
        }
        echo $read;
        flush();
        $remaining -= strlen($read);
    }
    fclose($fh);
    exit;
}

try {
    // ---- Avatars, logos: small public-ish images under _storage ----
    if (isset($_GET['a'])) {
        $rel = ltrim((string)$_GET['a'], '/');
        if (!preg_match('#^(avatars|logos)/[A-Za-z0-9._-]+$#', $rel)) {
            http_response_code(400);
            exit('Bad path.');
        }
        $abs = Storage::abs($rel);
        $ext = strtolower(pathinfo($abs, PATHINFO_EXTENSION));
        $mimes = ['png' => 'image/png', 'jpg' => 'image/jpeg', 'webp' => 'image/webp', 'gif' => 'image/gif'];
        myloom_stream($abs, $mimes[$ext] ?? 'application/octet-stream', false, 'image', 86400);
    }

    $uid = (string)($_GET['v'] ?? $_GET['t'] ?? $_GET['c'] ?? '');
    if ($uid === '') {
        http_response_code(400);
        exit('Nothing requested.');
    }

    $video = Db::one(
        'SELECT v.* FROM videos v WHERE v.uid = ?',
        [$uid]
    );
    if (!$video) {
        http_response_code(404);
        exit('Not found.');
    }

    $share = null;
    $token = (string)($_GET['token'] ?? '');
    if ($token !== '') {
        $share = Db::one('SELECT * FROM share_links WHERE token = ? AND video_id = ?', [$token, (int)$video['id']]);
    }

    [$allowed] = Permissions::canWatch($video, $share);
    if (!$allowed) {
        http_response_code(403);
        exit('You do not have access to this file.');
    }

    // ---- Poster image ----
    if (isset($_GET['t'])) {
        if (empty($video['thumbnail'])) {
            http_response_code(404);
            exit('No thumbnail.');
        }
        $abs = Storage::abs((string)$video['thumbnail']);
        $ext = strtolower(pathinfo($abs, PATHINFO_EXTENSION));
        $mimes = ['png' => 'image/png', 'jpg' => 'image/jpeg', 'webp' => 'image/webp', 'gif' => 'image/gif'];
        myloom_stream($abs, $mimes[$ext] ?? 'image/jpeg', false, 'poster', 604800);
    }

    // ---- Captions ----
    if (isset($_GET['c'])) {
        require_once APP_DIR . '/controllers/TranscriptController.php';
        $vtt = TranscriptController::vtt((int)$video['id']);
        Auth::release();
        header('Content-Type: text/vtt; charset=utf-8');
        header('Cache-Control: private, max-age=300');
        echo $vtt;
        exit;
    }

    // ---- Video ----
    $download = isset($_GET['dl']);
    if ($download) {
        $allowDownload = (int)$video['allow_download'] === 1 && (!$share || (int)$share['allow_download'] === 1);
        if (!$allowDownload && !Permissions::canManageVideo($video)) {
            http_response_code(403);
            exit('Downloads are disabled for this video.');
        }
    }
    if (empty($video['file_path'])) {
        http_response_code(404);
        exit('No media file.');
    }

    $ext = strtolower(pathinfo((string)$video['file_path'], PATHINFO_EXTENSION)) ?: 'webm';
    $name = preg_replace('/[^A-Za-z0-9._ -]/', '_', (string)$video['title']) . '.' . $ext;
    myloom_stream(
        Storage::abs((string)$video['file_path']),
        (string)$video['mime'],
        $download,
        $name,
        $download ? 0 : 604800
    );
} catch (Throwable $e) {
    error_log('[myloom][file] ' . $e->getMessage());
    http_response_code(500);
    exit('Server error.');
}
