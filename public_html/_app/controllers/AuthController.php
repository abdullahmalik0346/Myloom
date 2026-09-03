<?php
/** Sign-up, sign-in, password reset and profile management. */
final class AuthController
{
    /** GET /api/auth/me — bootstrap payload for the SPA. */
    public static function me(): void
    {
        $user = Auth::user();
        $payload = [
            'csrf'          => Auth::csrf(),
            'allow_signup'  => (bool)Config::get('allow_signup'),
            'site_name'     => Config::setting('site_name', 'MyLoom'),
            'base_url'      => Config::get('app_url'),
            'max_upload_mb' => (int)Config::get('max_upload_mb'),
            'user'          => null,
            'workspace'     => null,
            'workspaces'    => [],
        ];

        if ($user) {
            $wsId = Auth::workspaceId();
            $payload['user'] = [
                'id'              => (int)$user['id'],
                'name'            => $user['name'],
                'email'           => $user['email'],
                'avatar'          => $user['avatar'] ? Util::url('file.php?a=' . rawurlencode($user['avatar'])) : null,
                'is_admin'        => (int)$user['is_admin'] === 1,
                'timezone'        => $user['timezone'],
                'notify_view'     => (int)$user['notify_view'] === 1,
                'notify_comment'  => (int)$user['notify_comment'] === 1,
                'notify_reaction' => (int)$user['notify_reaction'] === 1,
            ];
            $payload['workspaces'] = WorkspaceController::listFor((int)$user['id']);
            foreach ($payload['workspaces'] as $ws) {
                if ((int)$ws['id'] === $wsId) {
                    $payload['workspace'] = $ws;
                }
            }
            $payload['unread'] = (int)Db::value(
                'SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL',
                [(int)$user['id']]
            );
        }

        Http::json($payload);
    }

    public static function signup(): void
    {
        if (!Config::get('allow_signup')) {
            $inviteToken = Http::str('invite');
            if ($inviteToken === '') {
                Http::fail('Sign-ups are disabled on this installation. Ask an admin for an invite.', 403);
            }
        }
        Auth::throttle('signup', 5, 600);

        $name  = Http::str('name');
        $email = strtolower(Http::str('email'));
        $pass  = (string)Http::input('password', '');

        if (mb_strlen($name) < 2) {
            Http::fail('Please enter your name.');
        }
        if (!Util::isEmail($email)) {
            Http::fail('That email address does not look valid.');
        }
        if (strlen($pass) < 8) {
            Http::fail('Choose a password with at least 8 characters.');
        }
        if (Db::value('SELECT id FROM users WHERE email = ?', [$email])) {
            Http::fail('An account with that email already exists.');
        }

        $inviteToken = Http::str('invite');
        $invite = $inviteToken !== ''
            ? Db::one('SELECT * FROM invites WHERE token = ? AND accepted_at IS NULL', [$inviteToken])
            : null;
        if ($inviteToken !== '' && (!$invite || strtotime((string)$invite['expires_at']) < time())) {
            Http::fail('That invitation link is invalid or has expired.');
        }

        $userId = Db::transaction(static function () use ($name, $email, $pass, $invite) {
            $userId = Db::insert('users', [
                'name'           => $name,
                'email'          => $email,
                'password_hash'  => password_hash($pass, PASSWORD_DEFAULT),
                'is_admin'       => Db::value('SELECT COUNT(*) FROM users') == 0 ? 1 : 0,
                'email_verified' => $invite ? 1 : 0,
                'created_at'     => Util::now(),
            ]);

            if ($invite) {
                Db::insert('workspace_members', [
                    'workspace_id' => (int)$invite['workspace_id'],
                    'user_id'      => $userId,
                    'role'         => $invite['role'],
                    'created_at'   => Util::now(),
                ]);
                Db::update('invites', ['accepted_at' => Util::now()], 'id = ?', [(int)$invite['id']]);
            } else {
                WorkspaceController::createWorkspace($userId, $name . "'s workspace");
            }
            return $userId;
        });

        Auth::login($userId);
        Http::ok(['user_id' => $userId, 'csrf' => Auth::csrf()]);
    }

    public static function login(): void
    {
        Auth::throttle('login', 10, 300);
        $email = strtolower(Http::str('email'));
        $pass  = (string)Http::input('password', '');

        $user = Db::one('SELECT * FROM users WHERE email = ?', [$email]);
        if (!$user || !password_verify($pass, (string)$user['password_hash'])) {
            Http::fail('Incorrect email or password.', 401);
        }
        if ((int)$user['is_active'] !== 1) {
            Http::fail('This account has been deactivated.', 403);
        }
        if (password_needs_rehash((string)$user['password_hash'], PASSWORD_DEFAULT)) {
            Db::update('users', ['password_hash' => password_hash($pass, PASSWORD_DEFAULT)], 'id = ?', [(int)$user['id']]);
        }

        Auth::login((int)$user['id']);
        Http::ok(['csrf' => Auth::csrf()]);
    }

    public static function logout(): void
    {
        Auth::logout();
        Http::ok();
    }

    public static function forgot(): void
    {
        Auth::throttle('forgot', 5, 900);
        $email = strtolower(Http::str('email'));
        $user = Db::one('SELECT id, name, email FROM users WHERE email = ?', [$email]);

        if ($user) {
            $token = Util::token(24);
            Db::insert('password_resets', [
                'user_id'    => (int)$user['id'],
                'token'      => $token,
                'expires_at' => gmdate('Y-m-d H:i:s', time() + 3600),
            ]);
            $link = Util::url('reset?token=' . $token);
            Mailer::send(
                (string)$user['email'],
                (string)$user['name'],
                'Reset your password',
                '<p>Hi ' . Util::e((string)$user['name']) . ',</p>'
                . '<p>Use the button below to choose a new password. The link expires in one hour.</p>'
                . Mailer::button('Reset password', $link)
                . '<p style="color:#8a8a99;font-size:13px">If you did not request this, you can ignore this email.</p>'
            );
        }
        // Always report success so the endpoint cannot be used to enumerate accounts.
        Http::ok(['sent' => true]);
    }

    public static function reset(): void
    {
        $token = Http::str('token');
        $pass  = (string)Http::input('password', '');
        if (strlen($pass) < 8) {
            Http::fail('Choose a password with at least 8 characters.');
        }
        $row = Db::one('SELECT * FROM password_resets WHERE token = ? AND used_at IS NULL', [$token]);
        if (!$row || strtotime((string)$row['expires_at']) < time()) {
            Http::fail('That reset link is invalid or has expired.');
        }
        Db::update('users', ['password_hash' => password_hash($pass, PASSWORD_DEFAULT)], 'id = ?', [(int)$row['user_id']]);
        Db::update('password_resets', ['used_at' => Util::now()], 'id = ?', [(int)$row['id']]);
        Auth::login((int)$row['user_id']);
        Http::ok(['csrf' => Auth::csrf()]);
    }

    public static function profile(): void
    {
        $user = Auth::require();
        $data = [];

        $name = Http::str('name');
        if ($name !== '') {
            $data['name'] = $name;
        }
        $tz = Http::str('timezone');
        if ($tz !== '' && in_array($tz, timezone_identifiers_list(), true)) {
            $data['timezone'] = $tz;
        }
        foreach (['notify_view', 'notify_comment', 'notify_reaction'] as $flag) {
            if (Http::input($flag) !== null) {
                $data[$flag] = Http::bool($flag) ? 1 : 0;
            }
        }
        $avatar = Http::str('avatar_data');
        if ($avatar !== '') {
            $rel = Storage::saveDataUrl($avatar, 'avatars', 'u' . (int)$user['id'] . '-' . substr(Util::token(4), 0, 6));
            if ($rel) {
                Storage::delete($user['avatar'] ?? null);
                $data['avatar'] = $rel;
            }
        }

        if ($data) {
            Db::update('users', $data, 'id = ?', [(int)$user['id']]);
        }
        Http::ok();
    }

    public static function password(): void
    {
        $user = Auth::require();
        $current = (string)Http::input('current_password', '');
        $next    = (string)Http::input('password', '');
        $hash = (string)Db::value('SELECT password_hash FROM users WHERE id = ?', [(int)$user['id']]);
        if (!password_verify($current, $hash)) {
            Http::fail('Your current password is incorrect.');
        }
        if (strlen($next) < 8) {
            Http::fail('Choose a password with at least 8 characters.');
        }
        Db::update('users', ['password_hash' => password_hash($next, PASSWORD_DEFAULT)], 'id = ?', [(int)$user['id']]);
        Http::ok();
    }

    /** Accept a workspace invitation while already signed in. */
    public static function acceptInvite(): void
    {
        $user = Auth::require();
        $invite = Db::one('SELECT * FROM invites WHERE token = ? AND accepted_at IS NULL', [Http::str('token')]);
        if (!$invite || strtotime((string)$invite['expires_at']) < time()) {
            Http::fail('That invitation link is invalid or has expired.');
        }
        $exists = Permissions::roleIn((int)$invite['workspace_id'], (int)$user['id']);
        if (!$exists) {
            Db::insert('workspace_members', [
                'workspace_id' => (int)$invite['workspace_id'],
                'user_id'      => (int)$user['id'],
                'role'         => $invite['role'],
                'created_at'   => Util::now(),
            ]);
        }
        Db::update('invites', ['accepted_at' => Util::now()], 'id = ?', [(int)$invite['id']]);
        Auth::setWorkspace((int)$invite['workspace_id']);
        Http::ok(['workspace_id' => (int)$invite['workspace_id']]);
    }
}
