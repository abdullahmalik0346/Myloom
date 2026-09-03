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

        $abs = Storage::abs((string)$video['file_path']);
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

        $finfo = new finfo(FILEINFO_MIME_TYPE);
        $mime  = (string)$finfo->file($tmp);
        $allowed = ['video/webm' => 'webm', 'video/mp4' => 'mp4', 'video/quicktime' => 'mov', 'video/x-matroska' => 'mkv'];
        if (!isset($allowed[$mime])) {
            Http::fail('Only WebM, MP4, MOV and MKV video files can be uploaded (detected: ' . $mime . ').');
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
