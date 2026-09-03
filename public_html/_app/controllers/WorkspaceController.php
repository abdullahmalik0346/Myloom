<?php
/** Workspaces (teams), members, invitations and branding. */
final class WorkspaceController
{
    public static function createWorkspace(int $ownerId, string $name): int
    {
        $slug = Util::slug($name);
        $base = $slug;
        $i = 2;
        while (Db::value('SELECT id FROM workspaces WHERE slug = ?', [$slug])) {
            $slug = $base . '-' . $i++;
        }
        $wsId = Db::insert('workspaces', [
            'name'       => $name,
            'slug'       => $slug,
            'owner_id'   => $ownerId,
            'created_at' => Util::now(),
        ]);
        Db::insert('workspace_members', [
            'workspace_id' => $wsId,
            'user_id'      => $ownerId,
            'role'         => 'owner',
            'created_at'   => Util::now(),
        ]);
        return $wsId;
    }

    public static function listFor(int $userId): array
    {
        $rows = Db::all(
            'SELECT w.*, m.role FROM workspaces w
             JOIN workspace_members m ON m.workspace_id = w.id
             WHERE m.user_id = ? ORDER BY w.name ASC',
            [$userId]
        );
        return array_map(static fn(array $w) => self::shape($w), $rows);
    }

    private static function shape(array $w): array
    {
        return [
            'id'            => (int)$w['id'],
            'name'          => $w['name'],
            'slug'          => $w['slug'],
            'role'          => $w['role'] ?? 'member',
            'logo'          => !empty($w['logo']) ? Util::url('file.php?a=' . rawurlencode($w['logo'])) : null,
            'accent_color'  => $w['accent_color'],
            'hide_branding' => (int)$w['hide_branding'] === 1,
            'cta_label'     => $w['default_cta_label'],
            'cta_url'       => $w['default_cta_url'],
            'storage_used'  => (int)$w['storage_used'],
            'storage_human' => Util::bytes((int)$w['storage_used']),
        ];
    }

    public static function index(): void
    {
        $user = Auth::require();
        Http::ok(['workspaces' => self::listFor((int)$user['id'])]);
    }

    public static function create(): void
    {
        $user = Auth::require();
        $name = Http::str('name');
        if (mb_strlen($name) < 2) {
            Http::fail('Give the workspace a name.');
        }
        $wsId = self::createWorkspace((int)$user['id'], $name);
        Auth::setWorkspace($wsId);
        Http::ok(['workspace_id' => $wsId]);
    }

    public static function switch(): void
    {
        $user = Auth::require();
        $wsId = Http::int('workspace_id');
        if (!Permissions::roleIn($wsId, (int)$user['id'])) {
            Http::fail('You are not a member of that workspace.', 403);
        }
        Auth::setWorkspace($wsId);
        Http::ok();
    }

    /** Branding: name, logo, accent colour, default CTA, branding toggle. */
    public static function update(): void
    {
        $wsId = Auth::workspaceId();
        Permissions::requireMember($wsId, 'admin');

        $data = [];
        $name = Http::str('name');
        if ($name !== '') {
            $data['name'] = $name;
        }
        $accent = Http::str('accent_color');
        if (preg_match('/^#[0-9a-fA-F]{6}$/', $accent)) {
            $data['accent_color'] = $accent;
        }
        if (Http::input('hide_branding') !== null) {
            $data['hide_branding'] = Http::bool('hide_branding') ? 1 : 0;
        }
        if (Http::input('cta_label') !== null) {
            $data['default_cta_label'] = mb_substr(Http::str('cta_label'), 0, 80) ?: null;
        }
        if (Http::input('cta_url') !== null) {
            $url = Http::str('cta_url');
            $data['default_cta_url'] = $url !== '' ? filter_var($url, FILTER_VALIDATE_URL) ?: null : null;
        }
        $logo = Http::str('logo_data');
        if ($logo !== '') {
            $rel = Storage::saveDataUrl($logo, 'logos', 'w' . $wsId . '-' . substr(Util::token(4), 0, 6));
            if ($rel) {
                $old = Db::value('SELECT logo FROM workspaces WHERE id = ?', [$wsId]);
                Storage::delete($old ? (string)$old : null);
                $data['logo'] = $rel;
            }
        }
        if (Http::bool('remove_logo')) {
            $old = Db::value('SELECT logo FROM workspaces WHERE id = ?', [$wsId]);
            Storage::delete($old ? (string)$old : null);
            $data['logo'] = null;
        }

        if ($data) {
            Db::update('workspaces', $data, 'id = ?', [$wsId]);
        }
        Http::ok();
    }

    public static function members(): void
    {
        $wsId = Auth::workspaceId();
        Permissions::requireMember($wsId, 'viewer');

        $members = Db::all(
            'SELECT m.id, m.role, m.created_at, u.id AS user_id, u.name, u.email, u.avatar,
                    (SELECT COUNT(*) FROM videos v WHERE v.owner_id = u.id AND v.workspace_id = m.workspace_id AND v.deleted_at IS NULL) AS video_count
             FROM workspace_members m JOIN users u ON u.id = m.user_id
             WHERE m.workspace_id = ? ORDER BY FIELD(m.role, "owner","admin","member","viewer"), u.name',
            [$wsId]
        );
        foreach ($members as &$m) {
            $m['avatar'] = $m['avatar'] ? Util::url('file.php?a=' . rawurlencode($m['avatar'])) : null;
            $m['user_id'] = (int)$m['user_id'];
            $m['video_count'] = (int)$m['video_count'];
        }
        unset($m);

        $invites = Db::all(
            'SELECT id, email, role, token, expires_at, created_at FROM invites
             WHERE workspace_id = ? AND accepted_at IS NULL ORDER BY created_at DESC',
            [$wsId]
        );
        foreach ($invites as &$inv) {
            $inv['link'] = Util::url('invite?token=' . $inv['token']);
            unset($inv['token']);
        }
        unset($inv);

        Http::ok(['members' => $members, 'invites' => $invites]);
    }

    public static function invite(): void
    {
        $wsId = Auth::workspaceId();
        $user = Permissions::requireMember($wsId, 'admin');

        $email = strtolower(Http::str('email'));
        $role  = Http::str('role', 'member');
        if (!Util::isEmail($email)) {
            Http::fail('Enter a valid email address to invite.');
        }
        if (!in_array($role, ['admin', 'member', 'viewer'], true)) {
            $role = 'member';
        }

        $existing = Db::one('SELECT u.id FROM users u JOIN workspace_members m ON m.user_id = u.id
                             WHERE u.email = ? AND m.workspace_id = ?', [$email, $wsId]);
        if ($existing) {
            Http::fail('That person is already in this workspace.');
        }

        $token = Util::token(24);
        Db::insert('invites', [
            'workspace_id' => $wsId,
            'email'        => $email,
            'role'         => $role,
            'token'        => $token,
            'invited_by'   => (int)$user['id'],
            'expires_at'   => gmdate('Y-m-d H:i:s', time() + 14 * 86400),
            'created_at'   => Util::now(),
        ]);

        $wsName = (string)Db::value('SELECT name FROM workspaces WHERE id = ?', [$wsId]);
        $link = Util::url('invite?token=' . $token);
        $sent = Mailer::send(
            $email,
            $email,
            Util::e((string)$user['name']) . ' invited you to ' . $wsName,
            '<p><strong>' . Util::e((string)$user['name']) . '</strong> invited you to join the '
            . '<strong>' . Util::e($wsName) . '</strong> workspace.</p>'
            . Mailer::button('Join workspace', $link)
            . '<p style="color:#8a8a99;font-size:13px">Or paste this link into your browser:<br>' . Util::e($link) . '</p>'
        );

        Http::ok(['link' => $link, 'emailed' => $sent]);
    }

    public static function memberRole(): void
    {
        $wsId = Auth::workspaceId();
        Permissions::requireMember($wsId, 'admin');
        $memberId = Http::int('member_id');
        $role = Http::str('role');
        if (!in_array($role, ['admin', 'member', 'viewer'], true)) {
            Http::fail('Unknown role.');
        }
        $member = Db::one('SELECT * FROM workspace_members WHERE id = ? AND workspace_id = ?', [$memberId, $wsId]);
        if (!$member) {
            Http::fail('Member not found.', 404);
        }
        if ($member['role'] === 'owner') {
            Http::fail('The workspace owner\'s role cannot be changed.');
        }
        Db::update('workspace_members', ['role' => $role], 'id = ?', [$memberId]);
        Http::ok();
    }

    public static function memberRemove(): void
    {
        $wsId = Auth::workspaceId();
        $actor = Permissions::requireMember($wsId, 'admin');
        $memberId = Http::int('member_id');
        $member = Db::one('SELECT * FROM workspace_members WHERE id = ? AND workspace_id = ?', [$memberId, $wsId]);
        if (!$member) {
            Http::fail('Member not found.', 404);
        }
        if ($member['role'] === 'owner') {
            Http::fail('The workspace owner cannot be removed.');
        }
        if ((int)$member['user_id'] === (int)$actor['id']) {
            Http::fail('Use "Leave workspace" to remove yourself.');
        }
        Db::run('DELETE FROM workspace_members WHERE id = ?', [$memberId]);
        Http::ok();
    }

    public static function inviteRevoke(): void
    {
        $wsId = Auth::workspaceId();
        Permissions::requireMember($wsId, 'admin');
        Db::run('DELETE FROM invites WHERE id = ? AND workspace_id = ?', [Http::int('invite_id'), $wsId]);
        Http::ok();
    }

    public static function leave(): void
    {
        $user = Auth::require();
        $wsId = Auth::workspaceId();
        $role = Permissions::roleIn($wsId, (int)$user['id']);
        if ($role === 'owner') {
            Http::fail('Transfer ownership before leaving this workspace.');
        }
        Db::run('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [$wsId, (int)$user['id']]);
        Auth::setWorkspace(0);
        Http::ok();
    }

    /** Public invite preview shown before sign-up. */
    public static function inviteInfo(): void
    {
        $invite = Db::one(
            'SELECT i.*, w.name AS workspace_name, u.name AS inviter
             FROM invites i JOIN workspaces w ON w.id = i.workspace_id
             JOIN users u ON u.id = i.invited_by
             WHERE i.token = ? AND i.accepted_at IS NULL',
            [Http::query('token')]
        );
        if (!$invite || strtotime((string)$invite['expires_at']) < time()) {
            Http::fail('That invitation link is invalid or has expired.', 404);
        }
        Http::ok([
            'workspace' => $invite['workspace_name'],
            'inviter'   => $invite['inviter'],
            'email'     => $invite['email'],
            'signed_in' => Auth::check(),
        ]);
    }
}
