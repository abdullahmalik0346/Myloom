<?php
/**
 * Keep-segments: the ordered list of source ranges that make up a video's
 * playback. One segment is exactly the old trim; several let you cut a section
 * out of the middle, keep separate pieces, or reorder them.
 *
 * Stored as JSON on the video row. Order is meaningful — it is the play order,
 * so segments are deliberately not sorted.
 */
final class Segments
{
    public const MAX = 200;

    /**
     * Normalise arbitrary input into a clean list.
     * Drops empty or reversed ranges and anything past the video length.
     */
    public static function normalise($input, float $duration): array
    {
        if (!is_array($input)) {
            return [];
        }
        $out = [];
        foreach (array_slice($input, 0, self::MAX) as $item) {
            if (!is_array($item)) {
                continue;
            }
            $start = max(0.0, (float)($item['start'] ?? 0));
            $end   = (float)($item['end'] ?? 0);
            if ($duration > 0) {
                $start = min($start, $duration);
                $end   = min($end, $duration);
            }
            // Anything shorter than a couple of frames is noise, not a segment.
            if ($end - $start < 0.08) {
                continue;
            }
            $out[] = ['start' => round($start, 3), 'end' => round($end, 3)];
        }
        return $out;
    }

    /** Total playing time of a segment list. */
    public static function duration(array $segments): float
    {
        $total = 0.0;
        foreach ($segments as $segment) {
            $total += max(0.0, (float)$segment['end'] - (float)$segment['start']);
        }
        return round($total, 2);
    }

    /** Read the stored list, falling back to the legacy trim fields. */
    public static function forVideo(array $video): array
    {
        if (!empty($video['segments'])) {
            $decoded = json_decode((string)$video['segments'], true);
            $segments = self::normalise($decoded, (float)$video['duration']);
            if ($segments) {
                return $segments;
            }
        }

        $start = (float)($video['trim_start'] ?? 0);
        $end = $video['trim_end'] !== null ? (float)$video['trim_end'] : (float)($video['duration'] ?? 0);
        if ($end <= $start) {
            $end = (float)($video['duration'] ?? 0);
        }
        if ($end <= $start) {
            return [];
        }
        return [['start' => round($start, 3), 'end' => round($end, 3)]];
    }

    /** True when the list is just "play the whole thing". */
    public static function isWhole(array $segments, float $duration): bool
    {
        if (count($segments) !== 1) {
            return false;
        }
        return $segments[0]['start'] <= 0.05 && ($duration <= 0 || $segments[0]['end'] >= $duration - 0.05);
    }

    public static function encode(array $segments): ?string
    {
        return $segments ? json_encode(array_values($segments)) : null;
    }
}
