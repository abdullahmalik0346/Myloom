<?php
/**
 * API tokens for the browser extension and any other non-browser client.
 *
 * The raw token is shown once, at creation, and only its SHA-256 is stored —
 * so a database leak does not hand over working credentials.
 */
final class TokenController
{
    public static function index(): void
    {
        $user = Auth::require();
        $rows = Db::all(
            'SELECT t.id, t.name, t.prefix, t.last_used_at, t.revoked, t.created_at, w.name AS workspace
             FROM api_tokens t LEFT JOIN workspaces w ON w.id = t.workspace_id
             WHERE t.user_id = ? ORDER BY t.created_at DESC',
            [(int)$user['id']]
        );
        Http::ok(['tokens' => array_map(static fn(array $t) => [
            'id'           => (int)$t['id'],
            'name'         => $t['name'],
            'preview'      => $t['prefix'] . '…',
            'workspace'    => $t['workspace'],
            'last_used_at' => $t['last_used_at'],
            'revoked'      => (int)$t['revoked'] === 1,
            'created_at'   => $t['created_at'],
        ], $rows)]);
    }

    public static function create(): void
    {
        $user = Auth::require();
        if (Auth::isTokenRequest()) {
            // A token must not be able to mint more tokens.
            Http::fail('Sign in on the website to create an API token.', 403);
        }
        if (count(Db::all('SELECT id FROM api_tokens WHERE user_id = ? AND revoked = 0', [(int)$user['id']])) >= 20) {
            Http::fail('You already have 20 active tokens. Revoke one first.');
        }

        $workspaceId = Http::int('workspace_id') ?: Auth::workspaceId();
        if ($workspaceId && Permissions::roleIn($workspaceId, (int)$user['id']) === null) {
            Http::fail('You are not a member of that workspace.', 403);
        }

        // "mlt_" makes the token recognisable in logs and secret scanners.
        $raw = 'mlt_' . Util::token(24);
        Db::insert('api_tokens', [
            'user_id'      => (int)$user['id'],
            'name'         => mb_substr(Http::str('name', 'Browser extension'), 0, 120) ?: 'Browser extension',
            'token_hash'   => hash('sha256', $raw),
            'prefix'       => substr($raw, 0, 12),
            'workspace_id' => $workspaceId ?: null,
            'created_at'   => Util::now(),
        ]);

        Http::ok([
            'token'   => $raw,
            'notice'  => 'Copy this now — it is not shown again.',
            'site'    => Config::get('app_url'),
        ]);
    }

    public static function revoke(): void
    {
        $user = Auth::require();
        $id = Http::int('id');
        $token = Db::one('SELECT id FROM api_tokens WHERE id = ? AND user_id = ?', [$id, (int)$user['id']]);
        if (!$token) {
            Http::fail('Token not found.', 404);
        }
        Db::update('api_tokens', ['revoked' => 1], 'id = ?', [$id]);
        Http::ok();
    }

    /** GET /api/tokens/whoami — what the extension calls to check its token. */
    public static function whoami(): void
    {
        $user = Auth::require();
        $wsId = Auth::workspaceId();
        $workspace = $wsId ? Db::one('SELECT id, name FROM workspaces WHERE id = ?', [$wsId]) : null;
        Http::ok([
            'user'      => ['id' => (int)$user['id'], 'name' => $user['name'], 'email' => $user['email']],
            'workspace' => $workspace ? ['id' => (int)$workspace['id'], 'name' => $workspace['name']] : null,
            'site'      => Config::get('app_url'),
            'version'   => MYLOOM,
        ]);
    }
}
