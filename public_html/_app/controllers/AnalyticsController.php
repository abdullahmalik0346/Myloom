<?php
/** Viewer analytics: per-video detail and workspace-wide overview. */
final class AnalyticsController
{
    /** GET /api/analytics/video?uid= */
    public static function video(): void
    {
        $video = VideoController::find(Http::query('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('Only the video owner can see analytics.', 403);
        }
        $id = (int)$video['id'];

        $totals = Db::one(
            'SELECT COUNT(*) AS views,
                    COUNT(DISTINCT session_key) AS uniques,
                    COALESCE(SUM(watched_sec), 0) AS total_watched,
                    COALESCE(AVG(percent), 0) AS avg_percent,
                    SUM(completed) AS completions
             FROM views WHERE video_id = ?',
            [$id]
        ) ?: [];

        $viewers = Db::all(
            'SELECT v.viewer_name, v.viewer_email, v.watched_sec, v.percent, v.completed,
                    v.device, v.referrer, v.created_at, v.updated_at, u.name AS user_name, u.avatar
             FROM views v LEFT JOIN users u ON u.id = v.user_id
             WHERE v.video_id = ? ORDER BY v.created_at DESC LIMIT 200',
            [$id]
        );
        $viewers = array_map(static fn(array $v) => [
            'name'        => $v['user_name'] ?: ($v['viewer_name'] ?: 'Anonymous viewer'),
            'email'       => $v['viewer_email'],
            'avatar'      => !empty($v['avatar']) ? Util::url('file.php?a=' . rawurlencode($v['avatar'])) : null,
            'watched_sec' => (float)$v['watched_sec'],
            'watched'     => Util::duration((float)$v['watched_sec']),
            'percent'     => (int)$v['percent'],
            'completed'   => (int)$v['completed'] === 1,
            'device'      => $v['device'],
            'referrer'    => $v['referrer'],
            'created_at'  => $v['created_at'],
        ], $viewers);

        $engagement = array_fill(0, 100, 0);
        foreach (Db::all('SELECT bucket, plays FROM engagement WHERE video_id = ?', [$id]) as $row) {
            $b = (int)$row['bucket'];
            if ($b >= 0 && $b < 100) {
                $engagement[$b] = (int)$row['plays'];
            }
        }

        $daily = Db::all(
            'SELECT DATE(created_at) AS day, COUNT(*) AS n FROM views
             WHERE video_id = ? AND created_at >= DATE_SUB(UTC_DATE(), INTERVAL 29 DAY)
             GROUP BY DATE(created_at) ORDER BY day ASC',
            [$id]
        );

        $devices = Db::all(
            'SELECT device, COUNT(*) AS n FROM views WHERE video_id = ? GROUP BY device',
            [$id]
        );

        $referrers = Db::all(
            'SELECT COALESCE(NULLIF(referrer, ""), "Direct") AS source, COUNT(*) AS n
             FROM views WHERE video_id = ? GROUP BY source ORDER BY n DESC LIMIT 10',
            [$id]
        );

        Http::ok([
            'totals' => [
                'views'         => (int)($totals['views'] ?? 0),
                'uniques'       => (int)($totals['uniques'] ?? 0),
                'watch_time'    => (float)($totals['total_watched'] ?? 0),
                'watch_human'   => Util::duration((float)($totals['total_watched'] ?? 0)),
                'avg_percent'   => round((float)($totals['avg_percent'] ?? 0)),
                'completions'   => (int)($totals['completions'] ?? 0),
                'comments'      => (int)Db::value('SELECT COUNT(*) FROM comments WHERE video_id = ? AND deleted_at IS NULL', [$id]),
                'reactions'     => (int)Db::value('SELECT COUNT(*) FROM reactions WHERE video_id = ?', [$id]),
                'cta_clicks'    => (int)Db::value('SELECT COUNT(*) FROM link_clicks WHERE video_id = ?', [$id]),
                'cta_clickers'  => (int)Db::value(
                    'SELECT COUNT(DISTINCT session_key) FROM link_clicks WHERE video_id = ?', [$id]),
            ],
            'viewers'    => $viewers,
            'engagement' => $engagement,
            'daily'      => array_map(static fn(array $d) => ['day' => $d['day'], 'views' => (int)$d['n']], $daily),
            'devices'    => array_map(static fn(array $d) => ['device' => $d['device'] ?: 'unknown', 'count' => (int)$d['n']], $devices),
            'referrers'  => array_map(static fn(array $r) => ['source' => $r['source'], 'count' => (int)$r['n']], $referrers),
            'clicks'     => array_map(static fn(array $c) => [
                'url'   => $c['url'],
                'kind'  => $c['kind'],
                'count' => (int)$c['n'],
            ], Db::all(
                'SELECT COALESCE(url, "(no link)") AS url, kind, COUNT(*) AS n
                 FROM link_clicks WHERE video_id = ? GROUP BY url, kind ORDER BY n DESC LIMIT 12',
                [$id]
            )),
        ]);
    }

    /** GET /api/analytics/overview — workspace dashboard. */
    public static function overview(): void
    {
        $wsId = Auth::workspaceId();
        $user = Permissions::requireMember($wsId, 'viewer');
        $isAdmin = Permissions::atLeast($wsId, (int)$user['id'], 'admin');

        $scope = $isAdmin ? '' : ' AND v.owner_id = ' . (int)$user['id'];

        $totals = Db::one(
            "SELECT COUNT(*) AS videos,
                    COALESCE(SUM(v.view_count), 0) AS views,
                    COALESCE(SUM(v.duration), 0) AS duration,
                    COALESCE(SUM(v.size_bytes), 0) AS storage
             FROM videos v WHERE v.workspace_id = ? AND v.deleted_at IS NULL{$scope}",
            [$wsId]
        ) ?: [];

        $watchTime = (float)Db::value(
            "SELECT COALESCE(SUM(vw.watched_sec), 0) FROM views vw
             JOIN videos v ON v.id = vw.video_id
             WHERE v.workspace_id = ? AND v.deleted_at IS NULL{$scope}",
            [$wsId]
        );

        $top = Db::all(
            "SELECT v.uid, v.title, v.view_count, v.duration, v.thumbnail
             FROM videos v WHERE v.workspace_id = ? AND v.deleted_at IS NULL{$scope}
             ORDER BY v.view_count DESC LIMIT 8",
            [$wsId]
        );

        $daily = Db::all(
            "SELECT DATE(vw.created_at) AS day, COUNT(*) AS n
             FROM views vw JOIN videos v ON v.id = vw.video_id
             WHERE v.workspace_id = ? AND vw.created_at >= DATE_SUB(UTC_DATE(), INTERVAL 29 DAY){$scope}
             GROUP BY DATE(vw.created_at) ORDER BY day ASC",
            [$wsId]
        );

        Http::ok([
            'totals' => [
                'videos'      => (int)($totals['videos'] ?? 0),
                'views'       => (int)($totals['views'] ?? 0),
                'duration'    => (float)($totals['duration'] ?? 0),
                'duration_human' => Util::duration((float)($totals['duration'] ?? 0)),
                'watch_time'  => $watchTime,
                'watch_human' => Util::duration($watchTime),
                'storage'     => (int)($totals['storage'] ?? 0),
                'storage_human' => Util::bytes((int)($totals['storage'] ?? 0)),
            ],
            'top' => array_map(static fn(array $t) => [
                'uid'        => $t['uid'],
                'title'      => $t['title'],
                'views'      => (int)$t['view_count'],
                'duration'   => Util::duration((float)$t['duration']),
                'thumbnail'  => !empty($t['thumbnail']) ? Util::url('file.php?t=' . rawurlencode((string)$t['uid'])) : null,
            ], $top),
            'daily' => array_map(static fn(array $d) => ['day' => $d['day'], 'views' => (int)$d['n']], $daily),
        ]);
    }

    /** GET /api/analytics/export?uid= — CSV of the viewer list. */
    public static function export(): void
    {
        $video = VideoController::find(Http::query('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('Only the video owner can export analytics.', 403);
        }
        $rows = Db::all(
            'SELECT v.viewer_name, v.viewer_email, v.watched_sec, v.percent, v.completed,
                    v.device, v.referrer, v.created_at, u.name AS user_name
             FROM views v LEFT JOIN users u ON u.id = v.user_id
             WHERE v.video_id = ? ORDER BY v.created_at DESC',
            [(int)$video['id']]
        );

        $filename = preg_replace('/[^A-Za-z0-9._-]/', '_', (string)$video['title']) . '-viewers.csv';
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $filename . '"');
        $out = fopen('php://output', 'w');
        // The $escape argument is passed explicitly: PHP 8.4 deprecates relying on its default.
        fputcsv($out, ['Viewer', 'Email', 'Watched (s)', 'Percent', 'Completed', 'Device', 'Referrer', 'Date (UTC)'], ',', '"', '\\');
        foreach ($rows as $r) {
            fputcsv($out, [
                $r['user_name'] ?: ($r['viewer_name'] ?: 'Anonymous'),
                $r['viewer_email'] ?: '',
                round((float)$r['watched_sec'], 1),
                (int)$r['percent'],
                (int)$r['completed'] === 1 ? 'yes' : 'no',
                $r['device'],
                $r['referrer'] ?: 'Direct',
                $r['created_at'],
            ], ',', '"', '\\');
        }
        fclose($out);
        exit;
    }
}
