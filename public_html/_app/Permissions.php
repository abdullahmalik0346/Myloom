<?php
/** Workspace roles and per-video access rules. */
final class Permissions
{
    private const RANK = ['viewer' => 1, 'member' => 2, 'admin' => 3, 'owner' => 4];

    /** Role of a user inside a workspace, or null when they are not a member. */
    public static function roleIn(int $workspaceId, int $userId): ?string
    {
        if ($workspaceId <= 0 || $userId <= 0) {
            return null;
        }
        $role = Db::value(
            'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
            [$workspaceId, $userId]
        );
        return $role === null ? null : (string)$role;
    }

    public static function atLeast(int $workspaceId, int $userId, string $minRole): bool
    {
        $role = self::roleIn($workspaceId, $userId);
        if ($role === null) {
            return false;
        }
        return (self::RANK[$role] ?? 0) >= (self::RANK[$minRole] ?? 99);
    }

    public static function requireMember(int $workspaceId, string $minRole = 'member'): array
    {
        $user = Auth::require();
        if (!self::atLeast($workspaceId, (int)$user['id'], $minRole)) {
            Http::fail('You do not have permission to do that in this workspace.', 403);
        }
        return $user;
    }

    /** Can the signed-in user edit / delete this video? */
    public static function canManageVideo(array $video, ?array $user = null): bool
    {
        $user = $user ?? Auth::user();
        if (!$user) {
            return false;
        }
        if ((int)$video['owner_id'] === (int)$user['id']) {
            return true;
        }
        if ((int)$user['is_admin'] === 1) {
            return true;
        }
        return self::atLeast((int)$video['workspace_id'], (int)$user['id'], 'admin');
    }

    /**
     * Decide whether the current request may watch a video.
     * Returns [allowed(bool), reason(string)] where reason is one of
     * '', 'not_found', 'password', 'expired', 'private', 'email'.
     */
    public static function canWatch(array $video, ?array $share = null): array
    {
        if (!empty($video['deleted_at'])) {
            return [false, 'not_found'];
        }
        $user = Auth::user();

        if ($user && self::canManageVideo($video, $user)) {
            return [true, ''];
        }

        if ($share) {
            if ((int)$share['revoked'] === 1) {
                return [false, 'not_found'];
            }
            if (!empty($share['expires_at']) && strtotime((string)$share['expires_at']) < time()) {
                return [false, 'expired'];
            }
            if (!empty($share['max_views']) && (int)$share['view_count'] >= (int)$share['max_views']) {
                return [false, 'expired'];
            }
            if (!empty($share['password_hash']) && !Auth::isUnlocked('share:' . $share['token'])) {
                return [false, 'password'];
            }
        }

        if (!empty($video['expires_at']) && strtotime((string)$video['expires_at']) < time()) {
            return [false, 'expired'];
        }

        switch ($video['visibility']) {
            case 'private':
                if (!$share) {
                    return [false, 'private'];
                }
                break;
            case 'workspace':
                $memberOk = $user && self::atLeast((int)$video['workspace_id'], (int)$user['id'], 'viewer');
                if (!$memberOk && !$share) {
                    return [false, 'private'];
                }
                break;
            case 'link':
            case 'public':
            default:
                break;
        }

        if (!empty($video['password_hash']) && !Auth::isUnlocked('video:' . $video['uid'])) {
            return [false, 'password'];
        }

        if ((int)$video['require_email'] === 1 && !$user && !Auth::guestIdentity()) {
            return [false, 'email'];
        }

        return [true, ''];
    }
}
