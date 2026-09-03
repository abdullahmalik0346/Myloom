<?php
/** Instance administration: users, global settings, storage health. */
final class AdminController
{
    public static function stats(): void
    {
        Auth::requireAdmin();
        Http::ok([
            'users'      => (int)Db::value('SELECT COUNT(*) FROM users'),
            'workspaces' => (int)Db::value('SELECT COUNT(*) FROM workspaces'),
            'videos'     => (int)Db::value('SELECT COUNT(*) FROM videos WHERE deleted_at IS NULL'),
            'views'      => (int)Db::value('SELECT COUNT(*) FROM views'),
            'storage'    => Util::bytes((int)Db::value('SELECT COALESCE(SUM(size_bytes),0) FROM videos')),
            'free_space' => Storage::freeSpace() !== null ? Util::bytes((int)Storage::freeSpace()) : 'unknown',
            'php'        => PHP_VERSION,
            'settings'   => [
                'site_name'    => Config::setting('site_name', 'MyLoom'),
                'allow_signup' => (bool)Config::get('allow_signup'),
                'ai_configured'=> ((string)Config::setting('ai_api_key', '')) !== '',
                'ai_base_url'  => Config::setting('ai_base_url', 'https://api.openai.com/v1'),
                'ai_model'     => Config::setting('ai_model', 'gpt-4o-mini'),
                'ai_transcribe_model' => Config::setting('ai_transcribe_model', 'whisper-1'),
                'smtp_host'    => Config::get('smtp_host'),
                'max_upload_mb'=> (int)Config::get('max_upload_mb'),
            ],
        ]);
    }

    public static function users(): void
    {
        Auth::requireAdmin();
        $rows = Db::all(
            'SELECT u.id, u.name, u.email, u.is_admin, u.is_active, u.created_at, u.last_login_at,
                    (SELECT COUNT(*) FROM videos v WHERE v.owner_id = u.id AND v.deleted_at IS NULL) AS videos
             FROM users u ORDER BY u.created_at DESC LIMIT 500'
        );
        Http::ok(['users' => $rows]);
    }

    public static function settings(): void
    {
        Auth::requireAdmin();
        foreach (['site_name', 'ai_api_key', 'ai_base_url', 'ai_model', 'ai_transcribe_model'] as $key) {
            if (Http::input($key) !== null) {
                Config::putSetting($key, mb_substr(Http::str($key), 0, 500));
            }
        }
        Http::ok();
    }

    public static function userToggle(): void
    {
        $me = Auth::requireAdmin();
        $id = Http::int('id');
        if ($id === (int)$me['id']) {
            Http::fail('You cannot deactivate your own account.');
        }
        $user = Db::one('SELECT id, is_active FROM users WHERE id = ?', [$id]);
        if (!$user) {
            Http::fail('User not found.', 404);
        }
        Db::update('users', ['is_active' => (int)$user['is_active'] === 1 ? 0 : 1], 'id = ?', [$id]);
        Http::ok();
    }
}
