<?php
/** In-app notification feed. */
final class NotificationController
{
    public static function index(): void
    {
        $user = Auth::require();
        $rows = Db::all(
            'SELECT n.*, v.uid AS video_uid, v.title AS video_title
             FROM notifications n LEFT JOIN videos v ON v.id = n.video_id
             WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 60',
            [(int)$user['id']]
        );
        Http::ok([
            'notifications' => array_map(static fn(array $n) => [
                'id'         => (int)$n['id'],
                'type'       => $n['type'],
                'actor'      => $n['actor'],
                'body'       => $n['body'],
                'video_uid'  => $n['video_uid'],
                'video_title'=> $n['video_title'],
                'read'       => $n['read_at'] !== null,
                'created_at' => $n['created_at'],
            ], $rows),
            'unread' => (int)Db::value('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL',
                [(int)$user['id']]),
        ]);
    }

    public static function read(): void
    {
        $user = Auth::require();
        $id = Http::int('id');
        if ($id > 0) {
            Db::update('notifications', ['read_at' => Util::now()], 'id = ? AND user_id = ?', [$id, (int)$user['id']]);
        } else {
            Db::run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL',
                [Util::now(), (int)$user['id']]);
        }
        Http::ok();
    }

    public static function clear(): void
    {
        $user = Auth::require();
        Db::run('DELETE FROM notifications WHERE user_id = ?', [(int)$user['id']]);
        Http::ok();
    }
}
