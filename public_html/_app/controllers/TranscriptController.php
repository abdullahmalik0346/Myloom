<?php
/**
 * Transcripts and captions.
 * Segments are captured in the browser during recording (Web Speech API) and
 * can optionally be refined by an OpenAI-compatible endpoint configured in
 * Settings → AI. A built-in extractive summariser runs when no key is set.
 */
final class TranscriptController
{
    public static function save(): void
    {
        $video = VideoController::find(Http::str('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('You can only edit your own videos.', 403);
        }

        $segments = Http::input('segments', []);
        if (!is_array($segments) || !$segments) {
            Http::fail('No transcript segments were supplied.');
        }

        $clean = [];
        $plain = [];
        foreach (array_slice($segments, 0, 5000) as $seg) {
            $text = trim((string)($seg['text'] ?? ''));
            if ($text === '') {
                continue;
            }
            $start = max(0, (float)($seg['start'] ?? 0));
            $end   = max($start, (float)($seg['end'] ?? $start + 3));
            $clean[] = ['start' => $start, 'end' => $end, 'text' => mb_substr($text, 0, 500)];
            $plain[] = $text;
        }
        if (!$clean) {
            Http::fail('The transcript was empty.');
        }

        $lang = mb_substr(Http::str('lang', 'en'), 0, 12);
        Db::run('DELETE FROM transcripts WHERE video_id = ? AND lang = ?', [(int)$video['id'], $lang]);
        Db::insert('transcripts', [
            'video_id'   => (int)$video['id'],
            'lang'       => $lang,
            'label'      => mb_substr(Http::str('label', 'English'), 0, 60),
            'segments'   => json_encode($clean, JSON_UNESCAPED_UNICODE),
            'plain_text' => mb_substr(implode(' ', $plain), 0, 4000000),
            'source'     => in_array(Http::str('source', 'browser'), ['browser', 'api', 'manual'], true)
                ? Http::str('source', 'browser') : 'browser',
            'created_at' => Util::now(),
        ]);

        Http::ok(['segments' => count($clean)]);
    }

    public static function get(): void
    {
        [$video, $share] = WatchController::resolve();
        [$allowed] = Permissions::canWatch($video, $share);
        if (!$allowed) {
            Http::fail('Not allowed.', 403);
        }
        $row = Db::one('SELECT * FROM transcripts WHERE video_id = ? ORDER BY is_default DESC, id ASC LIMIT 1',
            [(int)$video['id']]);
        if (!$row) {
            Http::ok(['transcript' => null]);
        }
        Http::ok(['transcript' => [
            'lang'     => $row['lang'],
            'label'    => $row['label'],
            'source'   => $row['source'],
            'segments' => json_decode((string)$row['segments'], true) ?: [],
            'text'     => $row['plain_text'],
        ]]);
    }

    /** Build a WebVTT file from stored segments. */
    public static function vtt(int $videoId): string
    {
        $row = Db::one('SELECT segments FROM transcripts WHERE video_id = ? ORDER BY is_default DESC, id ASC LIMIT 1',
            [$videoId]);
        $segments = $row ? (json_decode((string)$row['segments'], true) ?: []) : [];
        $out = "WEBVTT\n\n";
        foreach ($segments as $i => $seg) {
            $out .= ($i + 1) . "\n"
                . self::stamp((float)$seg['start']) . ' --> ' . self::stamp((float)$seg['end']) . "\n"
                . str_replace(["\r", "\n"], ' ', (string)$seg['text']) . "\n\n";
        }
        return $out;
    }

    private static function stamp(float $seconds): string
    {
        $h = intdiv((int)$seconds, 3600);
        $m = intdiv((int)$seconds % 3600, 60);
        $s = (int)$seconds % 60;
        $ms = (int)round(($seconds - floor($seconds)) * 1000);
        return sprintf('%02d:%02d:%02d.%03d', $h, $m, $s, $ms);
    }

    /** POST /api/transcript/summarize — AI title + summary + chapters, with a local fallback. */
    public static function summarize(): void
    {
        $video = VideoController::find(Http::str('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('You can only edit your own videos.', 403);
        }
        $row = Db::one('SELECT * FROM transcripts WHERE video_id = ? ORDER BY id ASC LIMIT 1', [(int)$video['id']]);
        if (!$row || trim((string)$row['plain_text']) === '') {
            Http::fail('This video has no transcript yet. Record with "Capture transcript" enabled, or paste one in.', 422);
        }

        $text = (string)$row['plain_text'];
        $apiKey = (string)Config::setting('ai_api_key', '');

        if ($apiKey !== '') {
            try {
                $result = self::callAi($apiKey, $text, (float)$video['duration']);
                self::applySummary($video, $result);
                Http::ok(['source' => 'ai'] + $result);
            } catch (Throwable $e) {
                error_log('[myloom][ai] ' . $e->getMessage());
                // Fall through to the local summariser rather than failing outright.
            }
        }

        $result = self::localSummary($text, (float)$video['duration'],
            json_decode((string)$row['segments'], true) ?: []);
        self::applySummary($video, $result);
        Http::ok(['source' => 'local'] + $result);
    }

    private static function applySummary(array $video, array $result): void
    {
        $data = ['updated_at' => Util::now()];
        if (!empty($result['summary'])) {
            $data['summary'] = mb_substr((string)$result['summary'], 0, 20000);
        }
        if (!empty($result['title']) && (
            $video['title'] === 'Untitled recording' || Http::bool('overwrite_title'))) {
            $data['title'] = mb_substr((string)$result['title'], 0, 255);
        }
        Db::update('videos', $data, 'id = ?', [(int)$video['id']]);

        if (!empty($result['chapters']) && is_array($result['chapters'])) {
            Db::run('DELETE FROM video_chapters WHERE video_id = ?', [(int)$video['id']]);
            foreach (array_slice($result['chapters'], 0, 50) as $c) {
                $title = trim((string)($c['title'] ?? ''));
                if ($title === '') {
                    continue;
                }
                Db::insert('video_chapters', [
                    'video_id'   => (int)$video['id'],
                    'start_time' => max(0, (float)($c['start_time'] ?? 0)),
                    'title'      => mb_substr($title, 0, 200),
                ]);
            }
        }
    }

    /** Call an OpenAI-compatible chat completions endpoint. */
    private static function callAi(string $apiKey, string $text, float $duration): array
    {
        if (!function_exists('curl_init')) {
            throw new RuntimeException('cURL is not available on this server.');
        }
        $base  = rtrim((string)Config::setting('ai_base_url', 'https://api.openai.com/v1'), '/');
        $model = (string)Config::setting('ai_model', 'gpt-4o-mini');

        $prompt = "You are summarising a screen-recording transcript.\n"
            . "Video length: " . round($duration) . " seconds.\n"
            . "Reply with JSON only, shaped as "
            . '{"title": string, "summary": string, "chapters": [{"start_time": number, "title": string}]}.' . "\n"
            . "Title: max 8 words. Summary: 2-4 sentences plus key points as '- ' lines. "
            . "Chapters: 3-8 entries with start_time in seconds inside the video length.\n\n"
            . "Transcript:\n" . mb_substr($text, 0, 24000);

        $ch = curl_init($base . '/chat/completions');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 60,
            CURLOPT_HTTPHEADER     => [
                'Content-Type: application/json',
                'Authorization: Bearer ' . $apiKey,
            ],
            CURLOPT_POSTFIELDS => json_encode([
                'model'    => $model,
                'messages' => [['role' => 'user', 'content' => $prompt]],
                'temperature' => 0.3,
            ]),
        ]);
        $body = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);

        if ($body === false || $status >= 400) {
            throw new RuntimeException('AI request failed (' . $status . '): ' . ($err ?: substr((string)$body, 0, 200)));
        }
        $json = json_decode((string)$body, true);
        $content = $json['choices'][0]['message']['content'] ?? '';
        if (preg_match('/\{.*\}/s', (string)$content, $m)) {
            $content = $m[0];
        }
        $parsed = json_decode((string)$content, true);
        if (!is_array($parsed)) {
            throw new RuntimeException('The AI response was not valid JSON.');
        }
        return [
            'title'    => (string)($parsed['title'] ?? ''),
            'summary'  => (string)($parsed['summary'] ?? ''),
            'chapters' => is_array($parsed['chapters'] ?? null) ? $parsed['chapters'] : [],
        ];
    }

    /**
     * Offline summariser: frequency-scored sentence extraction plus evenly
     * spaced chapters seeded from the transcript. No external service needed.
     */
    private static function localSummary(string $text, float $duration, array $segments): array
    {
        $sentences = preg_split('/(?<=[.!?])\s+/u', trim($text)) ?: [];
        $sentences = array_values(array_filter(array_map('trim', $sentences), static fn($s) => mb_strlen($s) > 25));

        $stop = array_flip(['the','and','that','this','with','have','from','they','you','your','for','are','was','but',
            'not','all','can','will','just','what','when','then','there','their','about','into','some','like','okay',
            'right','going','really','actually','know','here','were','been','also','over','than','them','out','get',
            'got','has','how','one','its','our','who','why','which','more','very','because','would','could','should']);

        $freq = [];
        foreach (preg_split('/\W+/u', mb_strtolower($text)) ?: [] as $word) {
            if (mb_strlen($word) < 4 || isset($stop[$word])) {
                continue;
            }
            $freq[$word] = ($freq[$word] ?? 0) + 1;
        }
        arsort($freq);

        $scores = [];
        foreach ($sentences as $i => $sentence) {
            $score = 0;
            foreach (preg_split('/\W+/u', mb_strtolower($sentence)) ?: [] as $word) {
                $score += $freq[$word] ?? 0;
            }
            $scores[$i] = $score / max(1, sqrt(mb_strlen($sentence)));
        }
        arsort($scores);
        $pick = array_slice(array_keys($scores), 0, 4);
        sort($pick);

        $summary = '';
        foreach ($pick as $i) {
            $summary .= $sentences[$i] . ' ';
        }
        $summary = trim($summary);
        if ($summary === '') {
            $summary = mb_substr($text, 0, 400);
        }

        $keywords = array_slice(array_keys($freq), 0, 5);
        if ($keywords) {
            $summary .= "\n\nKey topics: " . implode(', ', $keywords) . '.';
        }

        $title = $sentences ? mb_substr($sentences[0], 0, 70) : ($keywords ? ucfirst($keywords[0]) . ' walkthrough' : '');
        $title = rtrim($title, ' .,');

        $chapters = [];
        if ($segments && $duration > 60) {
            $count = min(6, max(3, (int)floor($duration / 90)));
            $step  = $duration / $count;
            for ($i = 0; $i < $count; $i++) {
                $at = $i * $step;
                $label = '';
                foreach ($segments as $seg) {
                    if ((float)$seg['start'] >= $at) {
                        $label = mb_substr((string)$seg['text'], 0, 48);
                        break;
                    }
                }
                $chapters[] = [
                    'start_time' => round($at, 2),
                    'title'      => $label !== '' ? rtrim($label, ' .,') : 'Part ' . ($i + 1),
                ];
            }
        }

        return ['title' => $title, 'summary' => $summary, 'chapters' => $chapters];
    }
}
