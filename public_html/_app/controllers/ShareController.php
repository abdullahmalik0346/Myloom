<?php
/** Share links: per-link passwords, expiry, view caps and revocation. */
final class ShareController
{
    public static function list(): void
    {
        $video = VideoController::find(Http::query('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('You can only manage links for your own videos.', 403);
        }
        $rows = Db::all(
            'SELECT * FROM share_links WHERE video_id = ? ORDER BY created_at DESC',
            [(int)$video['id']]
        );
        $links = array_map(static fn(array $r) => [
            'id'             => (int)$r['id'],
            'label'          => $r['label'],
            'url'            => Util::url('s/' . $r['token']),
            'has_password'   => !empty($r['password_hash']),
            'expires_at'     => $r['expires_at'],
            'max_views'      => $r['max_views'] !== null ? (int)$r['max_views'] : null,
            'view_count'     => (int)$r['view_count'],
            'allow_download' => (int)$r['allow_download'] === 1,
            'revoked'        => (int)$r['revoked'] === 1,
            'created_at'     => $r['created_at'],
        ], $rows);
        Http::ok(['links' => $links]);
    }

    public static function create(): void
    {
        $video = VideoController::find(Http::str('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('You can only create links for your own videos.', 403);
        }
        $user = Auth::require();

        $token = Util::uid(11);
        while (Db::value('SELECT id FROM share_links WHERE token = ?', [$token])) {
            $token = Util::uid(11);
        }
        $password = (string)Http::input('password', '');
        $expires  = Http::str('expires_at');
        $maxViews = Http::int('max_views');

        $id = Db::insert('share_links', [
            'video_id'       => (int)$video['id'],
            'token'          => $token,
            'label'          => mb_substr(Http::str('label'), 0, 120) ?: null,
            'password_hash'  => $password !== '' ? password_hash($password, PASSWORD_DEFAULT) : null,
            'expires_at'     => $expires !== '' ? gmdate('Y-m-d H:i:s', strtotime($expires) ?: time()) : null,
            'max_views'      => $maxViews > 0 ? $maxViews : null,
            'allow_download' => Http::bool('allow_download', true) ? 1 : 0,
            'created_by'     => (int)$user['id'],
            'created_at'     => Util::now(),
        ]);

        Http::ok(['id' => $id, 'url' => Util::url('s/' . $token)]);
    }

    public static function update(): void
    {
        $link = self::ownedLink(Http::int('id'));
        $data = [];
        if (Http::input('label') !== null) {
            $data['label'] = mb_substr(Http::str('label'), 0, 120) ?: null;
        }
        if (Http::input('password') !== null) {
            $pw = (string)Http::input('password', '');
            $data['password_hash'] = $pw === '' ? null : password_hash($pw, PASSWORD_DEFAULT);
        }
        if (Http::input('expires_at') !== null) {
            $exp = Http::str('expires_at');
            $data['expires_at'] = $exp === '' ? null : gmdate('Y-m-d H:i:s', strtotime($exp) ?: time());
        }
        if (Http::input('max_views') !== null) {
            $mv = Http::int('max_views');
            $data['max_views'] = $mv > 0 ? $mv : null;
        }
        if (Http::input('allow_download') !== null) {
            $data['allow_download'] = Http::bool('allow_download') ? 1 : 0;
        }
        if (Http::input('revoked') !== null) {
            $data['revoked'] = Http::bool('revoked') ? 1 : 0;
        }
        if ($data) {
            Db::update('share_links', $data, 'id = ?', [(int)$link['id']]);
        }
        Http::ok();
    }

    public static function revoke(): void
    {
        $link = self::ownedLink(Http::int('id'));
        Db::update('share_links', ['revoked' => 1], 'id = ?', [(int)$link['id']]);
        Http::ok();
    }

    public static function delete(): void
    {
        $link = self::ownedLink(Http::int('id'));
        Db::run('DELETE FROM share_links WHERE id = ?', [(int)$link['id']]);
        Http::ok();
    }

    private static function ownedLink(int $id): array
    {
        $link = Db::one('SELECT * FROM share_links WHERE id = ?', [$id]);
        if (!$link) {
            Http::fail('Share link not found.', 404);
        }
        $video = Db::one('SELECT * FROM videos WHERE id = ?', [(int)$link['video_id']]);
        if (!$video || !Permissions::canManageVideo($video)) {
            Http::fail('You can only manage links for your own videos.', 403);
        }
        return $link;
    }

    /** POST /api/share/unlock — a viewer submits the password for a protected video. */
    public static function unlock(): void
    {
        Auth::throttle('unlock', 12, 300);
        $uid   = Http::str('uid');
        $token = Http::str('token');
        $password = (string)Http::input('password', '');

        if ($token !== '') {
            $link = Db::one('SELECT * FROM share_links WHERE token = ?', [$token]);
            if ($link && !empty($link['password_hash']) && password_verify($password, (string)$link['password_hash'])) {
                Auth::unlock('share:' . $token);
                Http::ok(['unlocked' => true]);
            }
        }
        if ($uid !== '') {
            $video = Db::one('SELECT uid, password_hash FROM videos WHERE uid = ?', [$uid]);
            if ($video && !empty($video['password_hash']) && password_verify($password, (string)$video['password_hash'])) {
                Auth::unlock('video:' . $uid);
                Http::ok(['unlocked' => true]);
            }
        }
        Http::fail('That password is not correct.', 403);
    }

    /** POST /api/share/identify — viewer supplies name/email on a lead-gated video. */
    public static function identify(): void
    {
        $name  = mb_substr(Http::str('name'), 0, 120);
        $email = strtolower(Http::str('email'));
        if (!Util::isEmail($email)) {
            Http::fail('Enter a valid email address to continue.');
        }
        Auth::setGuestIdentity($name !== '' ? $name : explode('@', $email)[0], $email);
        Http::ok();
    }
}
