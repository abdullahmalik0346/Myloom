<?php
/**
 * Chunked, resumable uploads.
 * The recorder streams MediaRecorder blobs to /api/upload/chunk while recording,
 * so recording length is limited by disk space rather than browser memory or
 * PHP's upload_max_filesize.
 */
final class UploadController
{
    private static function session(): array
    {
        $key = Http::query('key') !== '' ? Http::query('key') : Http::str('key');
        $row = Db::one('SELECT * FROM uploads WHERE upload_key = ?', [$key]);
        if (!$row) {
            Http::fail('Unknown upload session.', 404);
        }
        if ((int)$row['user_id'] !== Auth::id()) {
            Http::fail('This upload does not belong to you.', 403);
        }
        return $row;
    }

    /** POST /api/upload/chunk?key=…&index=N  — raw binary body appended to the file. */
    public static function chunk(): void
    {
        Auth::require();
        $session = self::session();
        if ((int)$session['finished'] === 1) {
            Http::fail('This upload has already been finalised.', 409);
        }

        $video = Db::one('SELECT * FROM videos WHERE id = ?', [(int)$session['video_id']]);
        if (!$video) {
            Http::fail('The video for this upload no longer exists.', 404);
        }

        $index = (int)(Http::query('index') !== '' ? Http::query('index') : Http::int('index'));
        $expected = (int)$session['chunks'];
        if ($index < $expected) {
            // A retried chunk that already landed — acknowledge without re-appending.
            Http::ok(['received' => (int)$session['received'], 'chunks' => $expected, 'duplicate' => true]);
        }
        if ($index > $expected) {
            Http::fail('Chunk out of order; expected #' . $expected . '.', 409, ['expected' => $expected]);
        }

        $data = file_get_contents('php://input');
        if ($data === false || $data === '') {
            Http::fail('Empty chunk.');
        }
        $len = strlen($data);

        $maxBytes = (int)Config::get('max_upload_mb') * 1024 * 1024;
        if ($maxBytes > 0 && (int)$session['received'] + $len > $maxBytes) {
            Http::fail('This recording exceeded the maximum size of '
                . Config::get('max_upload_mb') . ' MB configured for this server.', 413);
        }
        $free = Storage::freeSpace();
        if ($free !== null && $free < $len + 50 * 1024 * 1024) {
            Http::fail('The server is out of disk space.', 507);
        }

        $target = !empty($session['temp_path']) ? (string)$session['temp_path'] : (string)$video['file_path'];
        $abs = Storage::abs($target);
        $fh = @fopen($abs, 'ab');
        if (!$fh) {
            Http::fail('Cannot write to storage. Check that _storage is writable (755).', 500);
        }
        flock($fh, LOCK_EX);
        $written = fwrite($fh, $data);
        fflush($fh);
        flock($fh, LOCK_UN);
        fclose($fh);

        if ($written === false || $written !== $len) {
            Http::fail('The chunk could not be written to disk in full.', 500);
        }

        Db::run(
            'UPDATE uploads SET received = received + ?, chunks = chunks + 1, updated_at = ? WHERE id = ?',
            [$len, Util::now(), (int)$session['id']]
        );

        Http::ok([
            'received' => (int)$session['received'] + $len,
            'chunks'   => $expected + 1,
        ]);
    }

    /** POST /api/upload/finish — mark the recording complete and store its metadata. */
    public static function finish(): void
    {
        Auth::require();
        $session = self::session();
        $video = Db::one('SELECT * FROM videos WHERE id = ?', [(int)$session['video_id']]);
        if (!$video) {
            Http::fail('The video for this upload no longer exists.', 404);
        }

        $size = Storage::size((string)$video['file_path']);
        if ($size === 0) {
            Db::update('videos', ['status' => 'failed', 'updated_at' => Util::now()], 'id = ?', [(int)$video['id']]);
            Http::fail('No video data was received, so nothing was saved.', 422);
        }

        $data = [
            'status'     => 'ready',
            'size_bytes' => $size,
            'duration'   => max(0, Http::float('duration')),
            'width'      => max(0, Http::int('width')),
            'height'     => max(0, Http::int('height')),
            'updated_at' => Util::now(),
        ];
        $title = Http::str('title');
        if ($title !== '') {
            $data['title'] = mb_substr($title, 0, 255);
        }
        $thumb = Http::str('thumbnail_data');
        if ($thumb !== '') {
            $rel = Storage::saveDataUrl($thumb, 'thumbs', (string)$video['uid']);
            if ($rel) {
                $data['thumbnail'] = $rel;
            }
        }

        Db::transaction(static function () use ($data, $video, $session, $size) {
            Db::update('videos', $data, 'id = ?', [(int)$video['id']]);
            Db::update('uploads', ['finished' => 1, 'updated_at' => Util::now()], 'id = ?', [(int)$session['id']]);
            Db::run('UPDATE workspaces SET storage_used = storage_used + ? WHERE id = ?',
                [$size, (int)$video['workspace_id']]);
        });

        Http::ok([
            'uid'       => $video['uid'],
            'share_url' => Util::url('v/' . $video['uid']),
            'size'      => $size,
            'size_human'=> Util::bytes($size),
        ]);
    }

    /** POST /api/upload/abort — discard a recording that was cancelled. */
    public static function abort(): void
    {
        Auth::require();
        $session = self::session();
        $video = Db::one('SELECT * FROM videos WHERE id = ?', [(int)$session['video_id']]);
        if ($video) {
            Storage::delete($video['file_path'] ?? null);
            Db::run('DELETE FROM videos WHERE id = ?', [(int)$video['id']]);
        }
        Db::run('DELETE FROM uploads WHERE id = ?', [(int)$session['id']]);
        Http::ok();
    }

    /** POST /api/upload/file — import an existing video file (multipart form). */
    public static function file(): void
    {
        $wsId = Auth::workspaceId();
        $user = Permissions::requireMember($wsId, 'member');

        if (empty($_FILES['file']) || ($_FILES['file']['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            $code = $_FILES['file']['error'] ?? UPLOAD_ERR_NO_FILE;
            $messages = [
                UPLOAD_ERR_INI_SIZE   => 'The file is larger than upload_max_filesize allows. Raise it in cPanel → MultiPHP INI Editor, or record in-app instead.',
                UPLOAD_ERR_FORM_SIZE  => 'The file is larger than the form allows.',
                UPLOAD_ERR_PARTIAL    => 'The upload was interrupted. Please try again.',
                UPLOAD_ERR_NO_FILE    => 'No file was selected.',
                UPLOAD_ERR_NO_TMP_DIR => 'The server has no temporary upload folder configured.',
                UPLOAD_ERR_CANT_WRITE => 'The server could not write the uploaded file to disk.',
            ];
            Http::fail($messages[$code] ?? 'The upload failed.', 400);
        }

        $tmp  = $_FILES['file']['tmp_name'];
        $name = (string)($_FILES['file']['name'] ?? 'video');
        $size = (int)$_FILES['file']['size'];

        $mime = Util::detectMime($tmp, $name);
        $allowed = ['video/webm' => 'webm', 'video/mp4' => 'mp4', 'video/quicktime' => 'mov', 'video/x-matroska' => 'mkv'];
        if ($mime === null || !isset($allowed[$mime])) {
            Http::fail('Only WebM, MP4, MOV and MKV video files can be uploaded (detected: '
                . ($mime ?? 'unknown') . ').');
        }

        $maxBytes = (int)Config::get('max_upload_mb') * 1024 * 1024;
        if ($maxBytes > 0 && $size > $maxBytes) {
            Http::fail('That file is larger than the ' . Config::get('max_upload_mb') . ' MB limit.', 413);
        }

        $uid = Util::uid(9);
        while (Db::value('SELECT id FROM videos WHERE uid = ?', [$uid])) {
            $uid = Util::uid(9);
        }
        $rel = Storage::videoPath($uid, $allowed[$mime]);
        if (!move_uploaded_file($tmp, Storage::abs($rel))) {
            Http::fail('The uploaded file could not be saved. Check that _storage is writable.', 500);
        }

        $spaceId = Http::int('space_id') ?: null;
        if ($spaceId && !Db::value('SELECT id FROM spaces WHERE id = ? AND workspace_id = ?', [$spaceId, $wsId])) {
            $spaceId = null;
        }
        $ws = Db::one('SELECT default_cta_label, default_cta_url FROM workspaces WHERE id = ?', [$wsId]);

        $videoId = Db::insert('videos', [
            'uid'          => $uid,
            'workspace_id' => $wsId,
            'space_id'     => $spaceId,
            'owner_id'     => (int)$user['id'],
            'title'        => mb_substr(pathinfo($name, PATHINFO_FILENAME) ?: 'Uploaded video', 0, 255),
            'file_path'    => $rel,
            'mime'         => $mime,
            'size_bytes'   => $size,
            'duration'     => max(0, (float)($_POST['duration'] ?? 0)),
            'width'        => max(0, (int)($_POST['width'] ?? 0)),
            'height'       => max(0, (int)($_POST['height'] ?? 0)),
            'status'       => 'ready',
            'source'       => 'upload',
            'visibility'   => 'link',
            'cta_label'    => $ws['default_cta_label'] ?? null,
            'cta_url'      => $ws['default_cta_url'] ?? null,
            'created_at'   => Util::now(),
            'updated_at'   => Util::now(),
        ]);

        if (!empty($_POST['thumbnail_data'])) {
            $thumbRel = Storage::saveDataUrl((string)$_POST['thumbnail_data'], 'thumbs', $uid);
            if ($thumbRel) {
                Db::update('videos', ['thumbnail' => $thumbRel], 'id = ?', [$videoId]);
            }
        }
        Db::run('UPDATE workspaces SET storage_used = storage_used + ? WHERE id = ?', [$size, $wsId]);

        Http::ok(['uid' => $uid, 'share_url' => Util::url('v/' . $uid)]);
    }

    /**
     * POST /api/upload/replace-start — begin uploading a replacement file for
     * an existing video. Bytes land in a staging file so the original stays
     * intact until the new one is known-good.
     */
    public static function replaceStart(): void
    {
        $video = VideoController::find(Http::str('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('You can only replace your own videos.', 403);
        }
        $user = Auth::require();

        $mime = Http::str('mime', 'video/webm');
        $ext = str_contains($mime, 'mp4') ? 'mp4' : 'webm';
        $temp = '/tmp/replace-' . $video['uid'] . '-' . substr(Util::token(4), 0, 8) . '.' . $ext;

        if (!is_dir(Storage::abs('/tmp'))) {
            @mkdir(Storage::abs('/tmp'), 0755, true);
        }
        if (@file_put_contents(Storage::abs($temp), '') === false) {
            Http::fail('The storage folder is not writable.', 500);
        }

        // Clear any half-finished previous attempt for this video.
        Db::run('DELETE FROM uploads WHERE video_id = ? AND finished = 0 AND temp_path IS NOT NULL',
            [(int)$video['id']]);

        $uploadKey = Util::token(16);
        Db::insert('uploads', [
            'upload_key' => $uploadKey,
            'video_id'   => (int)$video['id'],
            'user_id'    => (int)$user['id'],
            'temp_path'  => $temp,
            'created_at' => Util::now(),
            'updated_at' => Util::now(),
        ]);

        Http::ok(['upload_key' => $uploadKey, 'mime' => $mime]);
    }

    /**
     * POST /api/upload/replace-finish — swap the staged file in.
     * Trim and overlays are baked into the new file, so both are cleared to
     * avoid applying them a second time on playback.
     */
    public static function replaceFinish(): void
    {
        Auth::require();
        $session = self::session();
        if (empty($session['temp_path'])) {
            Http::fail('This upload is not a replacement.', 400);
        }
        $video = Db::one('SELECT * FROM videos WHERE id = ?', [(int)$session['video_id']]);
        if (!$video || !Permissions::canManageVideo($video)) {
            Http::fail('You can only replace your own videos.', 403);
        }

        $temp = (string)$session['temp_path'];
        $size = Storage::size($temp);
        if ($size < 1024) {
            Storage::delete($temp);
            Db::run('DELETE FROM uploads WHERE id = ?', [(int)$session['id']]);
            Http::fail('The replacement file was empty, so nothing was changed.', 422);
        }

        $mime = Http::str('mime', (string)$video['mime']);
        $ext = str_contains($mime, 'mp4') ? 'mp4' : 'webm';
        $newPath = Storage::videoPath((string)$video['uid'], $ext);
        $oldPath = (string)$video['file_path'];
        $oldSize = (int)$video['size_bytes'];

        // Move the staged file into place, then drop the original.
        if (!@rename(Storage::abs($temp), Storage::abs($newPath))) {
            if (!@copy(Storage::abs($temp), Storage::abs($newPath))) {
                Http::fail('The new file could not be moved into place.', 500);
            }
            Storage::delete($temp);
        }
        if ($oldPath !== '' && $oldPath !== $newPath) {
            Storage::delete($oldPath);
        }

        $duration = Http::float('duration');
        $data = [
            'file_path'  => $newPath,
            'mime'       => $mime,
            'size_bytes' => $size,
            'trim_start' => 0,
            'trim_end'   => null,
            'status'     => 'ready',
            'updated_at' => Util::now(),
        ];
        if ($duration > 0) {
            $data['duration'] = round($duration, 2);
        }
        if (Http::int('width') > 0) {
            $data['width'] = Http::int('width');
            $data['height'] = Http::int('height');
        }

        $clearAnnotations = Http::bool('clear_annotations', true);

        Db::transaction(static function () use ($data, $video, $session, $size, $oldSize, $clearAnnotations) {
            Db::update('videos', $data, 'id = ?', [(int)$video['id']]);
            if ($clearAnnotations) {
                Db::run('DELETE FROM annotations WHERE video_id = ?', [(int)$video['id']]);
            }
            Db::run('DELETE FROM uploads WHERE id = ?', [(int)$session['id']]);
            Db::run(
                'UPDATE workspaces SET storage_used = GREATEST(0, CAST(storage_used AS SIGNED) - ? + ?) WHERE id = ?',
                [$oldSize, $size, (int)$video['workspace_id']]
            );
        });

        Http::ok([
            'uid'        => $video['uid'],
            'size'       => $size,
            'size_human' => Util::bytes($size),
        ]);
    }

    /** POST /api/upload/replace-abort — throw away a staged replacement. */
    public static function replaceAbort(): void
    {
        Auth::require();
        $session = self::session();
        if (!empty($session['temp_path'])) {
            Storage::delete((string)$session['temp_path']);
        }
        Db::run('DELETE FROM uploads WHERE id = ?', [(int)$session['id']]);
        Http::ok();
    }

    /** GET /api/upload/limits — surfaced in the UI so users know the server's ceilings. */
    public static function limits(): void
    {
        Auth::require();
        Http::ok([
            'max_upload_mb'       => (int)Config::get('max_upload_mb'),
            'php_upload_max'      => ini_get('upload_max_filesize'),
            'php_post_max'        => ini_get('post_max_size'),
            'php_max_execution'   => ini_get('max_execution_time'),
            'free_space'          => Storage::freeSpace(),
            'free_space_human'    => Storage::freeSpace() !== null ? Util::bytes((int)Storage::freeSpace()) : null,
        ]);
    }
}
