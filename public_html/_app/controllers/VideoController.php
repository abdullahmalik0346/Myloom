<?php
/** Video library: listing, metadata, privacy settings, trash. */
final class VideoController
{
    /** Shared serialiser for library/grid payloads. */
    public static function shape(array $v, bool $withOwner = true): array
    {
        $segments = Segments::forVideo($v);
        $playDuration = $segments ? Segments::duration($segments) : (float)$v['duration'];

        $out = [
            'uid'            => $v['uid'],
            'title'          => $v['title'],
            'description'    => $v['description'],
            'duration'       => (float)$v['duration'],
            'duration_human' => Util::duration((float)$v['duration']),
            'thumbnail'      => !empty($v['thumbnail'])
                ? Util::url('file.php?t=' . rawurlencode($v['uid']))
                : null,
            'status'         => $v['status'],
            'source'         => $v['source'],
            'visibility'     => $v['visibility'],
            'has_password'   => !empty($v['password_hash']),
            'expires_at'     => $v['expires_at'],
            'space_id'       => $v['space_id'] !== null ? (int)$v['space_id'] : null,
            'is_starred'     => (int)$v['is_starred'] === 1,
            'view_count'     => (int)$v['view_count'],
            'unique_viewers' => (int)$v['unique_viewers'],
            'size_bytes'     => (int)$v['size_bytes'],
            'size_human'     => Util::bytes((int)$v['size_bytes']),
            'created_at'     => $v['created_at'],
            'updated_at'     => $v['updated_at'],
            'share_url'      => Util::url('v/' . $v['uid']),
            'allow_comments' => (int)$v['allow_comments'] === 1,
            'allow_reactions'=> (int)$v['allow_reactions'] === 1,
            'allow_download' => (int)$v['allow_download'] === 1,
            'require_email'  => (int)$v['require_email'] === 1,
            'trim_start'     => (float)$v['trim_start'],
            'trim_end'       => $v['trim_end'] !== null ? (float)$v['trim_end'] : null,
            'segments'       => $segments,
            'play_duration'  => $playDuration,
            'play_duration_human' => Util::duration($playDuration),
            'is_cut'         => !Segments::isWhole($segments, (float)$v['duration']),
            'cta_label'      => $v['cta_label'],
            'cta_url'        => $v['cta_url'],
            'summary'        => $v['summary'] ?? null,
        ];
        if ($withOwner) {
            $out['owner'] = [
                'id'     => (int)$v['owner_id'],
                'name'   => $v['owner_name'] ?? '',
                'avatar' => !empty($v['owner_avatar']) ? Util::url('file.php?a=' . rawurlencode($v['owner_avatar'])) : null,
            ];
        }
        if (isset($v['comment_count'])) {
            $out['comment_count'] = (int)$v['comment_count'];
        }
        return $out;
    }

    /** Fetch a video by uid, or fail with 404. */
    public static function find(string $uid): array
    {
        $video = Db::one(
            'SELECT v.*, u.name AS owner_name, u.avatar AS owner_avatar
             FROM videos v JOIN users u ON u.id = v.owner_id WHERE v.uid = ?',
            [$uid]
        );
        if (!$video) {
            Http::fail('That video does not exist.', 404);
        }
        return $video;
    }

    /** GET /api/videos — filtered, searchable, paginated library. */
    public static function index(): void
    {
        $wsId = Auth::workspaceId();
        $user = Permissions::requireMember($wsId, 'viewer');

        $where  = ['v.workspace_id = ?', 'v.deleted_at IS NULL'];
        $params = [$wsId];

        $filter = Http::query('filter', 'all');
        if ($filter === 'mine') {
            $where[] = 'v.owner_id = ?';
            $params[] = (int)$user['id'];
        } elseif ($filter === 'starred') {
            $where[] = 'v.is_starred = 1 AND v.owner_id = ?';
            $params[] = (int)$user['id'];
        } elseif ($filter === 'shared') {
            $where[] = 'v.owner_id <> ?';
            $params[] = (int)$user['id'];
        }

        // Viewers and members only see videos they own or that are shared with the workspace.
        if (!Permissions::atLeast($wsId, (int)$user['id'], 'admin')) {
            $where[] = '(v.owner_id = ? OR v.visibility IN ("workspace","link","public"))';
            $params[] = (int)$user['id'];
        }

        $spaceParam = Http::query('space_id');
        if ($spaceParam === 'none') {
            $where[] = 'v.space_id IS NULL';
        } elseif ($spaceParam !== '' && ctype_digit($spaceParam)) {
            $where[] = 'v.space_id = ?';
            $params[] = (int)$spaceParam;
        }

        $q = Http::query('q');
        if ($q !== '') {
            $where[] = '(v.title LIKE ? OR v.description LIKE ? OR EXISTS (
                          SELECT 1 FROM transcripts t WHERE t.video_id = v.id AND t.plain_text LIKE ?))';
            $like = '%' . $q . '%';
            array_push($params, $like, $like, $like);
        }

        $sortMap = [
            'recent'  => 'v.created_at DESC',
            'oldest'  => 'v.created_at ASC',
            'views'   => 'v.view_count DESC',
            'title'   => 'v.title ASC',
            'longest' => 'v.duration DESC',
        ];
        $order = $sortMap[Http::query('sort', 'recent')] ?? $sortMap['recent'];

        $perPage = min(60, max(6, (int)Http::query('per_page', '24')));
        $page    = max(1, (int)Http::query('page', '1'));
        $offset  = ($page - 1) * $perPage;
        $whereSql = implode(' AND ', $where);

        $total = (int)Db::value("SELECT COUNT(*) FROM videos v WHERE {$whereSql}", $params);

        $rows = Db::all(
            "SELECT v.*, u.name AS owner_name, u.avatar AS owner_avatar,
                    (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id AND c.deleted_at IS NULL) AS comment_count
             FROM videos v JOIN users u ON u.id = v.owner_id
             WHERE {$whereSql} ORDER BY {$order} LIMIT {$perPage} OFFSET {$offset}",
            $params
        );

        Http::ok([
            'videos'    => array_map(static fn(array $v) => self::shape($v), $rows),
            'total'     => $total,
            'page'      => $page,
            'per_page'  => $perPage,
            'has_more'  => ($offset + count($rows)) < $total,
        ]);
    }

    /** GET /api/videos/get?uid= — full record for the owner-facing detail page. */
    public static function get(): void
    {
        $video = self::find(Http::query('uid'));
        if (!Permissions::canManageVideo($video)) {
            [$allowed] = Permissions::canWatch($video);
            if (!$allowed) {
                Http::fail('You do not have access to this video.', 403);
            }
        }
        $data = self::shape($video);
        $data['can_manage'] = Permissions::canManageVideo($video);
        $data['media_url']  = Util::url('file.php?v=' . rawurlencode($video['uid']));
        $data['embed_code'] = self::embedCode((string)$video['uid']);
        $data['chapters']   = Db::all(
            'SELECT id, start_time, title FROM video_chapters WHERE video_id = ? ORDER BY start_time ASC',
            [(int)$video['id']]
        );
        $data['has_transcript'] = (bool)Db::value('SELECT id FROM transcripts WHERE video_id = ? LIMIT 1', [(int)$video['id']]);
        $data['annotations'] = AnnotationController::forVideo((int)$video['id']);
        Http::ok(['video' => $data]);
    }

    public static function embedCode(string $uid): string
    {
        $src = Util::url('embed/' . $uid);
        return '<div style="position:relative;padding-bottom:56.25%;height:0"><iframe src="' . $src
            . '" frameborder="0" allowfullscreen allow="fullscreen; picture-in-picture"'
            . ' style="position:absolute;top:0;left:0;width:100%;height:100%;border-radius:10px"></iframe></div>';
    }

    /**
     * POST /api/videos/create — reserve a video row before recording starts,
     * so chunks can stream straight to disk.
     */
    public static function create(): void
    {
        $wsId = Auth::workspaceId();
        $user = Permissions::requireMember($wsId, 'member');

        $uid = Util::uid(9);
        while (Db::value('SELECT id FROM videos WHERE uid = ?', [$uid])) {
            $uid = Util::uid(9);
        }

        $source = Http::str('source', 'screen');
        if (!in_array($source, ['screen', 'camera', 'screen_camera', 'upload'], true)) {
            $source = 'screen';
        }
        $mime = Http::str('mime', 'video/webm');
        $ext  = str_contains($mime, 'mp4') ? 'mp4' : 'webm';

        $spaceId = Http::int('space_id') ?: null;
        if ($spaceId && !Db::value('SELECT id FROM spaces WHERE id = ? AND workspace_id = ?', [$spaceId, $wsId])) {
            $spaceId = null;
        }

        $ws = Db::one('SELECT default_cta_label, default_cta_url FROM workspaces WHERE id = ?', [$wsId]);
        $relPath = Storage::videoPath($uid, $ext);

        $videoId = Db::insert('videos', [
            'uid'          => $uid,
            'workspace_id' => $wsId,
            'space_id'     => $spaceId,
            'owner_id'     => (int)$user['id'],
            'title'        => mb_substr(Http::str('title', 'Untitled recording'), 0, 255) ?: 'Untitled recording',
            'file_path'    => $relPath,
            'mime'         => $mime,
            'status'       => 'recording',
            'source'       => $source,
            'visibility'   => Http::str('visibility', 'link'),
            'cta_label'    => $ws['default_cta_label'] ?? null,
            'cta_url'      => $ws['default_cta_url'] ?? null,
            'created_at'   => Util::now(),
            'updated_at'   => Util::now(),
        ]);

        $uploadKey = Util::token(16);
        Db::insert('uploads', [
            'upload_key' => $uploadKey,
            'video_id'   => $videoId,
            'user_id'    => (int)$user['id'],
            'created_at' => Util::now(),
            'updated_at' => Util::now(),
        ]);

        // Create the (empty) target file up front so append failures surface early.
        $abs = Storage::abs($relPath);
        if (@file_put_contents($abs, '') === false) {
            Http::fail('The storage folder is not writable. Set _storage to permission 755 (or 775).', 500);
        }

        Http::ok([
            'uid'        => $uid,
            'video_id'   => $videoId,
            'upload_key' => $uploadKey,
            'share_url'  => Util::url('v/' . $uid),
        ]);
    }

    public static function update(): void
    {
        $video = self::find(Http::str('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('You can only edit your own videos.', 403);
        }
        $data = ['updated_at' => Util::now()];

        if (Http::input('title') !== null) {
            $data['title'] = mb_substr(Http::str('title'), 0, 255) ?: 'Untitled recording';
        }
        if (Http::input('description') !== null) {
            $data['description'] = mb_substr((string)Http::input('description', ''), 0, 20000);
        }
        if (Http::input('summary') !== null) {
            $data['summary'] = mb_substr((string)Http::input('summary', ''), 0, 20000);
        }
        if (Http::input('visibility') !== null) {
            $vis = Http::str('visibility');
            if (in_array($vis, ['private', 'workspace', 'link', 'public'], true)) {
                $data['visibility'] = $vis;
            }
        }
        foreach (['allow_comments', 'allow_reactions', 'allow_download', 'require_email'] as $flag) {
            if (Http::input($flag) !== null) {
                $data[$flag] = Http::bool($flag) ? 1 : 0;
            }
        }
        if (Http::input('password') !== null) {
            $pw = (string)Http::input('password', '');
            $data['password_hash'] = $pw === '' ? null : password_hash($pw, PASSWORD_DEFAULT);
        }
        if (Http::input('expires_at') !== null) {
            $exp = Http::str('expires_at');
            $data['expires_at'] = $exp === '' ? null : gmdate('Y-m-d H:i:s', strtotime($exp) ?: time());
        }
        if (Http::input('trim_start') !== null) {
            $data['trim_start'] = max(0, Http::float('trim_start'));
            $data['segments'] = null;
        }
        if (Http::input('trim_end') !== null) {
            $end = Http::float('trim_end');
            $data['trim_end'] = $end > 0 ? $end : null;
            $data['segments'] = null;
        }
        if (Http::input('segments') !== null) {
            $segments = Segments::normalise(Http::input('segments', []), (float)$video['duration']);
            if (!$segments) {
                Http::fail('A video needs at least one segment to play.');
            }
            $data['segments'] = Segments::encode($segments);
            // Mirror the overall span into the legacy fields.
            $data['trim_start'] = $segments[0]['start'];
            $last = $segments[count($segments) - 1];
            $data['trim_end'] = count($segments) === 1 ? $last['end'] : null;
        }
        if (Http::input('cta_label') !== null) {
            $data['cta_label'] = mb_substr(Http::str('cta_label'), 0, 80) ?: null;
        }
        if (Http::input('cta_url') !== null) {
            $url = Http::str('cta_url');
            $data['cta_url'] = $url !== '' ? (filter_var($url, FILTER_VALIDATE_URL) ?: null) : null;
        }
        if (Http::input('space_id') !== null) {
            $spaceId = Http::int('space_id') ?: null;
            if ($spaceId && !Db::value('SELECT id FROM spaces WHERE id = ? AND workspace_id = ?',
                [$spaceId, (int)$video['workspace_id']])) {
                $spaceId = null;
            }
            $data['space_id'] = $spaceId;
        }
        $thumb = Http::str('thumbnail_data');
        if ($thumb !== '') {
            $rel = Storage::saveDataUrl($thumb, 'thumbs', (string)$video['uid']);
            if ($rel) {
                $data['thumbnail'] = $rel;
            }
        }

        Db::update('videos', $data, 'id = ?', [(int)$video['id']]);
        Http::ok();
    }

    public static function star(): void
    {
        $video = self::find(Http::str('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('You can only star your own videos.', 403);
        }
        $next = (int)$video['is_starred'] === 1 ? 0 : 1;
        Db::update('videos', ['is_starred' => $next], 'id = ?', [(int)$video['id']]);
        Http::ok(['is_starred' => $next === 1]);
    }

    public static function chapters(): void
    {
        $video = self::find(Http::str('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('You can only edit your own videos.', 403);
        }
        $chapters = Http::input('chapters', []);
        Db::run('DELETE FROM video_chapters WHERE video_id = ?', [(int)$video['id']]);
        if (is_array($chapters)) {
            foreach (array_slice($chapters, 0, 100) as $c) {
                $title = trim((string)($c['title'] ?? ''));
                if ($title === '') {
                    continue;
                }
                Db::insert('video_chapters', [
                    'video_id'   => (int)$video['id'],
                    'start_time' => max(0, (float)($c['start_time'] ?? 0)),
                    'title'      => mb_substr($title, 0, 200),
                ]);
            }
        }
        Http::ok();
    }

    public static function delete(): void
    {
        $video = self::find(Http::str('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('You can only delete your own videos.', 403);
        }
        Db::update('videos', ['deleted_at' => Util::now()], 'id = ?', [(int)$video['id']]);
        Http::ok();
    }

    public static function restore(): void
    {
        $video = self::find(Http::str('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('You can only restore your own videos.', 403);
        }
        Db::update('videos', ['deleted_at' => null], 'id = ?', [(int)$video['id']]);
        Http::ok();
    }

    /** Permanently delete the row and its media. */
    public static function purge(): void
    {
        $video = self::find(Http::str('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('You can only delete your own videos.', 403);
        }
        $id = (int)$video['id'];
        Storage::delete($video['file_path'] ?? null);
        Storage::delete($video['thumbnail'] ?? null);
        Db::transaction(static function () use ($id, $video) {
            foreach (['comments', 'reactions', 'views', 'engagement', 'share_links', 'transcripts',
                      'video_chapters', 'annotations', 'uploads', 'notifications'] as $table) {
                Db::run("DELETE FROM `{$table}` WHERE video_id = ?", [$id]);
            }
            Db::run('UPDATE workspaces SET storage_used = GREATEST(0, CAST(storage_used AS SIGNED) - ?) WHERE id = ?',
                [(int)$video['size_bytes'], (int)$video['workspace_id']]);
            Db::run('DELETE FROM videos WHERE id = ?', [$id]);
        });
        Http::ok();
    }

    public static function trash(): void
    {
        $wsId = Auth::workspaceId();
        $user = Permissions::requireMember($wsId, 'viewer');
        $rows = Db::all(
            'SELECT v.*, u.name AS owner_name, u.avatar AS owner_avatar
             FROM videos v JOIN users u ON u.id = v.owner_id
             WHERE v.workspace_id = ? AND v.deleted_at IS NOT NULL AND (v.owner_id = ? OR ? = 1)
             ORDER BY v.deleted_at DESC LIMIT 200',
            [$wsId, (int)$user['id'], Permissions::atLeast($wsId, (int)$user['id'], 'admin') ? 1 : 0]
        );
        Http::ok(['videos' => array_map(static fn(array $v) => self::shape($v), $rows)]);
    }

    /** Bulk move to a space (or to the root when space_id is 0). */
    public static function move(): void
    {
        $wsId = Auth::workspaceId();
        Permissions::requireMember($wsId, 'member');
        $uids = Http::input('uids', []);
        $spaceId = Http::int('space_id') ?: null;
        if ($spaceId && !Db::value('SELECT id FROM spaces WHERE id = ? AND workspace_id = ?', [$spaceId, $wsId])) {
            Http::fail('Space not found.', 404);
        }
        $moved = 0;
        foreach ((array)$uids as $uid) {
            $video = Db::one('SELECT * FROM videos WHERE uid = ? AND workspace_id = ?', [(string)$uid, $wsId]);
            if ($video && Permissions::canManageVideo($video)) {
                Db::update('videos', ['space_id' => $spaceId, 'updated_at' => Util::now()], 'id = ?', [(int)$video['id']]);
                $moved++;
            }
        }
        Http::ok(['moved' => $moved]);
    }
}
