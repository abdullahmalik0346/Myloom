<?php
/** Timestamped comments, threaded replies and emoji reactions. */
final class CommentController
{
    /** GET /api/comments?uid=|token= */
    public static function index(): void
    {
        [$video, $share] = WatchController::resolve();
        [$allowed] = Permissions::canWatch($video, $share);
        if (!$allowed) {
            Http::fail('Not allowed.', 403);
        }

        $rows = Db::all(
            'SELECT c.*, u.name AS user_name, u.avatar AS user_avatar
             FROM comments c LEFT JOIN users u ON u.id = c.user_id
             WHERE c.video_id = ? AND c.deleted_at IS NULL
             ORDER BY c.created_at ASC LIMIT 500',
            [(int)$video['id']]
        );

        $canManage = Permissions::canManageVideo($video);
        $me = Auth::id();
        $items = [];
        foreach ($rows as $r) {
            $items[] = [
                'id'          => (int)$r['id'],
                'parent_id'   => $r['parent_id'] !== null ? (int)$r['parent_id'] : null,
                'body'        => $r['body'],
                'at_time'     => $r['at_time'] !== null ? (float)$r['at_time'] : null,
                'is_resolved' => (int)$r['is_resolved'] === 1,
                'created_at'  => $r['created_at'],
                'author'      => [
                    'name'   => $r['user_name'] ?? ($r['guest_name'] ?: 'Guest'),
                    'avatar' => !empty($r['user_avatar']) ? Util::url('file.php?a=' . rawurlencode($r['user_avatar'])) : null,
                    'is_guest' => $r['user_id'] === null,
                ],
                'can_delete'  => $canManage || ($me > 0 && (int)$r['user_id'] === $me),
                'reactions'   => self::reactionSummary((int)$r['id']),
            ];
        }

        $timeline = Db::all(
            'SELECT emoji, at_time FROM reactions WHERE video_id = ? AND comment_id IS NULL AND at_time IS NOT NULL
             ORDER BY at_time ASC LIMIT 500',
            [(int)$video['id']]
        );

        Http::ok([
            'comments'  => $items,
            'reactions' => array_map(static fn(array $r) => [
                'emoji'   => $r['emoji'],
                'at_time' => (float)$r['at_time'],
            ], $timeline),
        ]);
    }

    private static function reactionSummary(int $commentId): array
    {
        $rows = Db::all(
            'SELECT emoji, COUNT(*) AS n FROM reactions WHERE comment_id = ? GROUP BY emoji ORDER BY n DESC',
            [$commentId]
        );
        return array_map(static fn(array $r) => ['emoji' => $r['emoji'], 'count' => (int)$r['n']], $rows);
    }

    /** POST /api/comments/create */
    public static function create(): void
    {
        Auth::throttle('comment', 20, 120);
        [$video, $share] = WatchController::resolve();
        [$allowed] = Permissions::canWatch($video, $share);
        if (!$allowed) {
            Http::fail('Not allowed.', 403);
        }
        if ((int)$video['allow_comments'] !== 1) {
            Http::fail('Comments are turned off for this video.', 403);
        }

        $body = trim((string)Http::input('body', ''));
        if ($body === '') {
            Http::fail('Write something first.');
        }
        if (mb_strlen($body) > 5000) {
            Http::fail('That comment is too long (5000 characters max).');
        }

        $user = Auth::user();
        $identity = Auth::guestIdentity();
        $guestName = mb_substr(Http::str('guest_name', (string)($identity['name'] ?? '')), 0, 120);
        if (!$user && $guestName === '') {
            $guestName = 'Guest';
        }

        $parentId = Http::int('parent_id') ?: null;
        if ($parentId && !Db::value('SELECT id FROM comments WHERE id = ? AND video_id = ?', [$parentId, (int)$video['id']])) {
            $parentId = null;
        }

        $atTime = Http::input('at_time') !== null ? max(0, Http::float('at_time')) : null;

        $id = Db::insert('comments', [
            'video_id'    => (int)$video['id'],
            'user_id'     => $user ? (int)$user['id'] : null,
            'guest_name'  => $user ? null : $guestName,
            'guest_email' => $user ? null : ($identity['email'] ?? null),
            'parent_id'   => $parentId,
            'body'        => $body,
            'at_time'     => $atTime,
            'created_at'  => Util::now(),
        ]);

        // A guest who signs their comment should not stay "Anonymous" in analytics.
        if (!$user && $guestName !== '' && $guestName !== 'Guest') {
            Db::run(
                'UPDATE views SET viewer_name = ? WHERE video_id = ? AND session_key = ? AND viewer_name IS NULL',
                [$guestName, (int)$video['id'], Auth::guestKey()]
            );
        }

        self::notify($video, $user ? (string)$user['name'] : $guestName, $body);
        Http::ok(['id' => $id]);
    }

    public static function delete(): void
    {
        $id = Http::int('id');
        $comment = Db::one('SELECT * FROM comments WHERE id = ?', [$id]);
        if (!$comment) {
            Http::fail('Comment not found.', 404);
        }
        $video = Db::one('SELECT * FROM videos WHERE id = ?', [(int)$comment['video_id']]);
        $me = Auth::id();
        if (!$video || (!Permissions::canManageVideo($video) && (int)$comment['user_id'] !== $me)) {
            Http::fail('You cannot delete that comment.', 403);
        }
        Db::update('comments', ['deleted_at' => Util::now()], 'id = ?', [$id]);
        Http::ok();
    }

    public static function resolve(): void
    {
        $id = Http::int('id');
        $comment = Db::one('SELECT * FROM comments WHERE id = ?', [$id]);
        if (!$comment) {
            Http::fail('Comment not found.', 404);
        }
        $video = Db::one('SELECT * FROM videos WHERE id = ?', [(int)$comment['video_id']]);
        if (!$video || !Permissions::canManageVideo($video)) {
            Http::fail('Only the video owner can resolve comments.', 403);
        }
        Db::update('comments', ['is_resolved' => (int)$comment['is_resolved'] === 1 ? 0 : 1], 'id = ?', [$id]);
        Http::ok();
    }

    /** POST /api/comments/react — emoji on a comment, or on the timeline. */
    public static function react(): void
    {
        Auth::throttle('react', 40, 120);
        [$video, $share] = WatchController::resolve();
        [$allowed] = Permissions::canWatch($video, $share);
        if (!$allowed) {
            Http::fail('Not allowed.', 403);
        }
        if ((int)$video['allow_reactions'] !== 1) {
            Http::fail('Reactions are turned off for this video.', 403);
        }

        $emoji = mb_substr(Http::str('emoji'), 0, 8);
        $allowedEmoji = ['👍', '❤️', '😂', '🎉', '👏', '😮', '🔥', '💡', '✅', '🙏'];
        if (!in_array($emoji, $allowedEmoji, true)) {
            Http::fail('Unsupported reaction.');
        }

        $user = Auth::user();
        $sessionKey = $user ? 'u' . (int)$user['id'] : Auth::guestKey();
        $commentId = Http::int('comment_id') ?: null;
        if ($commentId && !Db::value('SELECT id FROM comments WHERE id = ? AND video_id = ?', [$commentId, (int)$video['id']])) {
            Http::fail('Comment not found.', 404);
        }

        if ($commentId) {
            // Toggle: the same person clicking the same emoji removes it.
            $existing = Db::one(
                'SELECT id FROM reactions WHERE comment_id = ? AND emoji = ? AND session_key = ?',
                [$commentId, $emoji, $sessionKey]
            );
            if ($existing) {
                Db::run('DELETE FROM reactions WHERE id = ?', [(int)$existing['id']]);
                Http::ok(['removed' => true]);
            }
        }

        Db::insert('reactions', [
            'video_id'    => (int)$video['id'],
            'comment_id'  => $commentId,
            'user_id'     => $user ? (int)$user['id'] : null,
            'session_key' => $sessionKey,
            'emoji'       => $emoji,
            'at_time'     => $commentId ? null : max(0, Http::float('at_time')),
            'created_at'  => Util::now(),
        ]);

        if (!$commentId) {
            $owner = Db::one('SELECT id, name, email, notify_reaction FROM users WHERE id = ?', [(int)$video['owner_id']]);
            if ($owner && (!$user || (int)$user['id'] !== (int)$owner['id'])) {
                Db::insert('notifications', [
                    'user_id'    => (int)$owner['id'],
                    'type'       => 'reaction',
                    'video_id'   => (int)$video['id'],
                    'actor'      => $user['name'] ?? 'Someone',
                    'body'       => ($user['name'] ?? 'Someone') . ' reacted ' . $emoji . ' on "' . $video['title'] . '"',
                    'created_at' => Util::now(),
                ]);
            }
        }
        Http::ok(['added' => true]);
    }

    private static function notify(array $video, string $author, string $body): void
    {
        $owner = Db::one('SELECT id, name, email, notify_comment FROM users WHERE id = ?', [(int)$video['owner_id']]);
        if (!$owner || (int)$owner['id'] === Auth::id()) {
            return;
        }
        Db::insert('notifications', [
            'user_id'    => (int)$owner['id'],
            'type'       => 'comment',
            'video_id'   => (int)$video['id'],
            'actor'      => mb_substr($author, 0, 150),
            'body'       => mb_substr($author . ' commented on "' . $video['title'] . '"', 0, 500),
            'created_at' => Util::now(),
        ]);
        if ((int)$owner['notify_comment'] === 1) {
            Mailer::send(
                (string)$owner['email'],
                (string)$owner['name'],
                'New comment on ' . $video['title'],
                '<p><strong>' . Util::e($author) . '</strong> commented on '
                . '<strong>' . Util::e((string)$video['title']) . '</strong>:</p>'
                . '<blockquote style="margin:14px 0;padding:12px 16px;background:#f6f6fb;border-left:3px solid #625df5;border-radius:6px">'
                . nl2br(Util::e(mb_substr($body, 0, 800))) . '</blockquote>'
                . Mailer::button('Reply', Util::url('video/' . $video['uid']))
            );
        }
    }
}
