<?php
/**
 * On-video annotations: text captions, clickable links, blur boxes and shapes.
 *
 * Stored as timed, normalised rectangles (0-1 of the frame) rather than being
 * burned into the file, so editing stays instant and reversible. The player
 * draws them on the watch page and in embeds; "Download" can optionally burn
 * them in by re-encoding in the browser.
 */
final class AnnotationController
{
    private const TYPES = ['text', 'link', 'blur', 'rect', 'ellipse', 'arrow'];

    /** Serialise for the player and the editor. */
    public static function shape(array $row): array
    {
        return [
            'id'           => (int)$row['id'],
            'type'         => $row['type'],
            'start_time'   => (float)$row['start_time'],
            'end_time'     => (float)$row['end_time'],
            'x'            => (float)$row['x'],
            'y'            => (float)$row['y'],
            'w'            => (float)$row['w'],
            'h'            => (float)$row['h'],
            'body'         => $row['body'],
            'url'          => $row['url'],
            'color'        => $row['color'],
            'background'   => $row['background'],
            'font_size'    => (float)$row['font_size'],
            'stroke_width' => (float)$row['stroke_width'],
            'intensity'    => (int)$row['intensity'],
            'z_index'      => (int)$row['z_index'],
        ];
    }

    /** All annotations for a video, ordered for stable stacking. */
    public static function forVideo(int $videoId): array
    {
        $rows = Db::all(
            'SELECT * FROM annotations WHERE video_id = ? ORDER BY z_index ASC, start_time ASC, id ASC',
            [$videoId]
        );
        return array_map([self::class, 'shape'], $rows);
    }

    /** GET /api/annotations?uid=|token= — readable by anyone who may watch. */
    public static function index(): void
    {
        [$video, $share] = WatchController::resolve();
        [$allowed] = Permissions::canWatch($video, $share);
        if (!$allowed) {
            Http::fail('Not allowed.', 403);
        }
        Http::ok(['annotations' => self::forVideo((int)$video['id'])]);
    }

    /**
     * POST /api/annotations/save — replaces the whole set for a video.
     * The editor always sends the full list, which keeps ordering and deletes
     * trivial and avoids a per-item diff.
     */
    public static function save(): void
    {
        $video = VideoController::find(Http::str('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('You can only edit your own videos.', 403);
        }

        $items = Http::input('annotations', []);
        if (!is_array($items)) {
            Http::fail('Expected a list of annotations.');
        }
        if (count($items) > 200) {
            Http::fail('That is more than 200 annotations on one video.');
        }

        $duration = (float)$video['duration'];
        $clean = [];
        foreach ($items as $index => $item) {
            if (!is_array($item)) {
                continue;
            }
            $type = in_array(($item['type'] ?? ''), self::TYPES, true) ? $item['type'] : 'text';

            $start = max(0.0, (float)($item['start_time'] ?? 0));
            $end   = (float)($item['end_time'] ?? 0);
            if ($end <= $start) {
                $end = $start + 3;
            }
            if ($duration > 0) {
                $start = min($start, $duration);
                $end = min($end, max($duration, $start + 0.5));
            }

            $body = trim((string)($item['body'] ?? ''));
            $url = trim((string)($item['url'] ?? ''));
            if ($url !== '') {
                $url = filter_var($url, FILTER_VALIDATE_URL) ?: '';
                // Only http(s) links are rendered as clickable overlays.
                if ($url !== '' && !preg_match('#^https?://#i', $url)) {
                    $url = '';
                }
            }
            if ($type === 'link' && $url === '') {
                // A link with no destination is just a label.
                $type = 'text';
            }
            if (($type === 'text' || $type === 'link') && $body === '') {
                $body = $type === 'link' ? 'Learn more' : 'Text';
            }

            $clean[] = [
                'video_id'     => (int)$video['id'],
                'type'         => $type,
                'start_time'   => round($start, 2),
                'end_time'     => round($end, 2),
                'x'            => self::unit($item['x'] ?? 0.1),
                'y'            => self::unit($item['y'] ?? 0.1),
                'w'            => max(0.01, self::unit($item['w'] ?? 0.3)),
                'h'            => max(0.01, self::unit($item['h'] ?? 0.1)),
                'body'         => mb_substr($body, 0, 500) ?: null,
                'url'          => $url !== '' ? mb_substr($url, 0, 500) : null,
                'color'        => self::color($item['color'] ?? '#ffffff', '#ffffff'),
                'background'   => isset($item['background']) && $item['background'] !== ''
                    ? self::color($item['background'], '#000000') : null,
                'font_size'    => min(0.5, max(0.015, (float)($item['font_size'] ?? 0.05))),
                'stroke_width' => min(0.05, max(0.001, (float)($item['stroke_width'] ?? 0.006))),
                'intensity'    => min(60, max(2, (int)($item['intensity'] ?? 12))),
                'z_index'      => min(999, max(1, (int)($item['z_index'] ?? ($index + 1)))),
                'created_at'   => Util::now(),
            ];
        }

        Db::transaction(static function () use ($video, $clean) {
            Db::run('DELETE FROM annotations WHERE video_id = ?', [(int)$video['id']]);
            foreach ($clean as $row) {
                Db::insert('annotations', $row);
            }
            Db::update('videos', ['updated_at' => Util::now()], 'id = ?', [(int)$video['id']]);
        });

        Http::ok(['annotations' => self::forVideo((int)$video['id'])]);
    }

    /** Clamp a normalised coordinate. Positions may sit slightly off-frame. */
    private static function unit($value): float
    {
        return round(min(1.5, max(-0.5, (float)$value)), 5);
    }

    private static function color($value, string $fallback): string
    {
        $value = (string)$value;
        return preg_match('/^#[0-9a-fA-F]{6}$/', $value) ? strtolower($value) : $fallback;
    }
}
