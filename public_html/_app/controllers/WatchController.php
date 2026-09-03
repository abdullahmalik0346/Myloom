<?php
/** Public-facing playback: video payload, view tracking and engagement. */
final class WatchController
{
    /** Resolve a video from ?uid= or a share ?token=. Returns [video, share|null]. */
    public static function resolve(): array
    {
        $token = Http::query('token') !== '' ? Http::query('token') : Http::str('token');
        $uid   = Http::query('uid') !== '' ? Http::query('uid') : Http::str('uid');

        $share = null;
        if ($token !== '') {
            $share = Db::one('SELECT * FROM share_links WHERE token = ?', [$token]);
            if (!$share) {
                Http::fail('That share link does not exist.', 404);
            }
            $uid = (string)Db::value('SELECT uid FROM videos WHERE id = ?', [(int)$share['video_id']]);
        }
        if ($uid === '') {
            Http::fail('No video was requested.', 400);
        }
        $video = Db::one(
            'SELECT v.*, u.name AS owner_name, u.avatar AS owner_avatar, u.email AS owner_email,
                    w.name AS ws_name, w.logo AS ws_logo, w.accent_color AS ws_accent, w.hide_branding
             FROM videos v
             JOIN users u ON u.id = v.owner_id
             JOIN workspaces w ON w.id = v.workspace_id
             WHERE v.uid = ?',
            [$uid]
        );
        if (!$video) {
            Http::fail('That video does not exist.', 404);
        }
        return [$video, $share];
    }

    /** GET /api/watch — everything the player needs, respecting privacy rules. */
    public static function index(): void
    {
        [$video, $share] = self::resolve();
        [$allowed, $reason] = Permissions::canWatch($video, $share);

        $base = [
            'uid'        => $video['uid'],
            'title'      => $video['title'],
            'branding'   => [
                'workspace'     => $video['ws_name'],
                'logo'          => !empty($video['ws_logo']) ? Util::url('file.php?a=' . rawurlencode($video['ws_logo'])) : null,
                'accent'        => $video['ws_accent'],
                'hide_branding' => (int)$video['hide_branding'] === 1,
            ],
        ];

        if (!$allowed) {
            Http::json(['ok' => false, 'gate' => $reason, 'video' => $base], 200);
        }

        $canManage = Permissions::canManageVideo($video);
        $allowDownload = (int)$video['allow_download'] === 1
            && (!$share || (int)$share['allow_download'] === 1);

        $mediaQuery = 'file.php?v=' . rawurlencode((string)$video['uid']);
        if ($share) {
            $mediaQuery .= '&token=' . rawurlencode((string)$share['token']);
        }

        $payload = [
            'uid'             => $video['uid'],
            'title'           => $video['title'],
            'description'     => $video['description'],
            'summary'         => $video['summary'],
            'duration'        => (float)$video['duration'],
            'width'           => (int)$video['width'],
            'height'          => (int)$video['height'],
            'mime'            => $video['mime'],
            'media_url'       => Util::url($mediaQuery),
            'poster'          => !empty($video['thumbnail']) ? Util::url('file.php?t=' . rawurlencode((string)$video['uid'])) : null,
            'download_url'    => $allowDownload ? Util::url($mediaQuery . '&dl=1') : null,
            'trim_start'      => (float)$video['trim_start'],
            'trim_end'        => $video['trim_end'] !== null ? (float)$video['trim_end'] : null,
            'segments'        => Segments::forVideo($video),
            'play_duration'   => Segments::duration(Segments::forVideo($video)),
            'allow_comments'  => (int)$video['allow_comments'] === 1,
            'allow_reactions' => (int)$video['allow_reactions'] === 1,
            'allow_download'  => $allowDownload,
            'can_manage'      => $canManage,
            'created_at'      => $video['created_at'],
            'view_count'      => (int)$video['view_count'],
            'cta'             => $video['cta_url'] ? ['label' => $video['cta_label'] ?: 'Learn more', 'url' => $video['cta_url']] : null,
            'owner'           => [
                'name'   => $video['owner_name'],
                'avatar' => !empty($video['owner_avatar']) ? Util::url('file.php?a=' . rawurlencode($video['owner_avatar'])) : null,
            ],
            'branding'  => $base['branding'],
            'chapters'  => array_map(static fn(array $c) => [
                'start_time' => (float)$c['start_time'],
                'title'      => $c['title'],
            ], Db::all('SELECT start_time, title FROM video_chapters WHERE video_id = ? ORDER BY start_time', [(int)$video['id']])),
            'captions_url' => Db::value('SELECT id FROM transcripts WHERE video_id = ? LIMIT 1', [(int)$video['id']])
                ? Util::url('file.php?c=' . rawurlencode((string)$video['uid']))
                : null,
            'annotations'  => AnnotationController::forVideo((int)$video['id']),
            'embed_code'   => VideoController::embedCode((string)$video['uid']),
            'share_url'    => $share ? Util::url('s/' . $share['token']) : Util::url('v/' . $video['uid']),
        ];

        Http::json(['ok' => true, 'video' => $payload]);
    }

    /** POST /api/watch/view — records or refreshes a view row. */
    public static function view(): void
    {
        [$video, $share] = self::resolve();
        [$allowed] = Permissions::canWatch($video, $share);
        if (!$allowed) {
            Http::fail('Not allowed.', 403);
        }
        // The owner previewing their own video should not inflate the count.
        if (Permissions::canManageVideo($video)) {
            Http::ok(['counted' => false]);
        }

        $user = Auth::user();
        $sessionKey = $user ? 'u' . (int)$user['id'] : Auth::guestKey();
        $identity = Auth::guestIdentity();

        $existing = Db::one('SELECT * FROM views WHERE video_id = ? AND session_key = ?',
            [(int)$video['id'], $sessionKey]);

        if ($existing) {
            Db::update('views', ['updated_at' => Util::now()], 'id = ?', [(int)$existing['id']]);
            Http::ok(['counted' => false, 'view_id' => (int)$existing['id']]);
        }

        $viewId = Db::insert('views', [
            'video_id'     => (int)$video['id'],
            'user_id'      => $user ? (int)$user['id'] : null,
            'session_key'  => $sessionKey,
            'viewer_name'  => $user ? $user['name'] : ($identity['name'] ?? null),
            'viewer_email' => $user ? $user['email'] : ($identity['email'] ?? null),
            'ip_hash'      => Util::ipHash(),
            'user_agent'   => mb_substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255),
            'referrer'     => mb_substr(Http::str('referrer', (string)($_SERVER['HTTP_REFERER'] ?? '')), 0, 255) ?: null,
            'device'       => Util::device(),
            'created_at'   => Util::now(),
            'updated_at'   => Util::now(),
        ]);

        Db::run('UPDATE videos SET view_count = view_count + 1, unique_viewers = unique_viewers + 1 WHERE id = ?',
            [(int)$video['id']]);
        if ($share) {
            Db::run('UPDATE share_links SET view_count = view_count + 1 WHERE id = ?', [(int)$share['id']]);
        }

        self::notifyOwner($video, $user, $identity);
        Http::ok(['counted' => true, 'view_id' => $viewId]);
    }

    /** POST /api/watch/progress — heartbeat with watched seconds and played buckets. */
    public static function progress(): void
    {
        [$video, $share] = self::resolve();
        [$allowed] = Permissions::canWatch($video, $share);
        if (!$allowed || Permissions::canManageVideo($video)) {
            Http::ok(['recorded' => false]);
        }

        $user = Auth::user();
        $sessionKey = $user ? 'u' . (int)$user['id'] : Auth::guestKey();
        $view = Db::one('SELECT * FROM views WHERE video_id = ? AND session_key = ?',
            [(int)$video['id'], $sessionKey]);
        if (!$view) {
            Http::ok(['recorded' => false]);
        }

        $watched = max((float)$view['watched_sec'], Http::float('watched'));
        $percent = min(100, max(0, Http::int('percent')));
        Db::update('views', [
            'watched_sec' => $watched,
            'percent'     => max((int)$view['percent'], $percent),
            'completed'   => $percent >= 95 ? 1 : (int)$view['completed'],
            'updated_at'  => Util::now(),
        ], 'id = ?', [(int)$view['id']]);

        // Engagement graph: 0-99 buckets across the video's length.
        $buckets = Http::input('buckets', []);
        if (is_array($buckets) && $buckets) {
            foreach (array_slice(array_unique(array_map('intval', $buckets)), 0, 100) as $bucket) {
                if ($bucket < 0 || $bucket > 99) {
                    continue;
                }
                Db::run(
                    'INSERT INTO engagement (video_id, bucket, plays) VALUES (?, ?, 1)
                     ON DUPLICATE KEY UPDATE plays = plays + 1',
                    [(int)$video['id'], $bucket]
                );
            }
        }
        Http::ok(['recorded' => true]);
    }

    private static function notifyOwner(array $video, ?array $user, array $identity): void
    {
        $ownerId = (int)$video['owner_id'];
        if ($user && (int)$user['id'] === $ownerId) {
            return;
        }
        $who = $user['name'] ?? ($identity['name'] ?? 'Someone');
        Db::insert('notifications', [
            'user_id'    => $ownerId,
            'type'       => 'view',
            'video_id'   => (int)$video['id'],
            'actor'      => mb_substr((string)$who, 0, 150),
            'body'       => mb_substr($who . ' watched "' . $video['title'] . '"', 0, 500),
            'created_at' => Util::now(),
        ]);

        $owner = Db::one('SELECT name, email, notify_view FROM users WHERE id = ?', [$ownerId]);
        if ($owner && (int)$owner['notify_view'] === 1) {
            Mailer::send(
                (string)$owner['email'],
                (string)$owner['name'],
                $who . ' watched your video',
                '<p><strong>' . Util::e((string)$who) . '</strong> just watched '
                . '<strong>' . Util::e((string)$video['title']) . '</strong>.</p>'
                . Mailer::button('View analytics', Util::url('video/' . $video['uid']))
            );
        }
    }
}
